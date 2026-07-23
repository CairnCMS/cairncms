import type { Accountability, Query, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import getDatabase from '../../database/index.js';
import { isInternalTable } from '../../database/internal-tables.js';
import { ForbiddenException } from '../../exceptions/index.js';
import { ItemsService, type MutationTracker } from '../../services/items.js';
import type { Item, MutationOptions, PrimaryKey } from '../../types/items.js';
import { getSchema } from '../../utils/get-schema.js';
import type { ConfinedItemsReader, ConfinedItemsServiceFactory, ConfinedItemsWriter } from './host-items.js';

/** The confined per-verb mutation ceiling, applied as the lower of this and the operator's MAX_BATCH_MUTATION. */
export const CONFINED_WRITE_MAX_MUTATIONS = 500;

/** The read slice of the platform items service the confined reader consumes. */
export interface ConfinedReadService {
	readByQuery(query: Query, opts: { emitEvents: boolean }): Promise<unknown>;
	readOne(key: string | number, query: Query, opts: { emitEvents: boolean }): Promise<unknown>;
}

/** The write slice of the platform items service the confined writer consumes. */
export interface ConfinedWriteService {
	createOne(data: Partial<Item>, opts: MutationOptions): Promise<PrimaryKey>;
	createMany(data: Partial<Item>[], opts: MutationOptions): Promise<PrimaryKey[]>;
	updateOne(key: PrimaryKey, data: Partial<Item>, opts: MutationOptions): Promise<PrimaryKey>;
	updateMany(keys: PrimaryKey[], data: Partial<Item>, opts: MutationOptions): Promise<PrimaryKey[]>;
	deleteOne(key: PrimaryKey, opts: MutationOptions): Promise<PrimaryKey>;
	deleteMany(keys: PrimaryKey[], opts: MutationOptions): Promise<PrimaryKey[]>;
	createMutationTracker(initialCount: number, options: { maxCount: number }): MutationTracker;
}

export interface ConfinedItemsServiceDeps {
	database: () => Knex;
	schema: (options: { database: Knex }) => Promise<SchemaOverview>;
	service: (
		collection: string,
		options: { knex: Knex; schema: SchemaOverview; accountability: Accountability | null }
	) => ConfinedReadService & ConfinedWriteService;
}

/**
 * Builds the production items factory for the confined bindings. The service is
 * constructed per call with the current database and schema, the exact authority
 * the broker resolved (the invocation's accountability under current-user, the
 * explicit null under declared system). A read runs with events off so a brokered
 * read never fires item read or query emissions. A write runs with events on and a
 * single bounded mutation tracker, so filter and action hooks fire and the whole
 * graph rolls back if it exceeds the confined ceiling. A collection absent from the
 * schema is refused as forbidden before the service exists, so a guest cannot
 * distinguish a collection that does not exist from one it cannot reach.
 */
export function createConfinedItemsService(deps: ConfinedItemsServiceDeps): ConfinedItemsServiceFactory {
	return (collection, accountability): ConfinedItemsReader & ConfinedItemsWriter => {
		async function buildService(): Promise<ConfinedReadService & ConfinedWriteService> {
			if (collection.startsWith('directus_') || isInternalTable(collection)) throw new ForbiddenException();

			const knex = deps.database();
			const schema = await deps.schema({ database: knex });

			// An own-property check, because a prototype-named collection (constructor,
			// __proto__) would otherwise pass through the prototype chain and reach the
			// service as if it existed, answering internal instead of the collapse.
			if (!Object.hasOwn(schema.collections, collection)) throw new ForbiddenException();

			return deps.service(collection, { knex, schema, accountability });
		}

		function writeOptions(service: ConfinedWriteService): MutationOptions {
			return {
				mutationTracker: service.createMutationTracker(0, { maxCount: CONFINED_WRITE_MAX_MUTATIONS }),
				emitEvents: true,
			};
		}

		return {
			async readByQuery(query) {
				return (await buildService()).readByQuery(query, { emitEvents: false });
			},

			async readOne(key, query) {
				return (await buildService()).readOne(key, query, { emitEvents: false });
			},

			async createOne(payload) {
				const service = await buildService();
				return service.createOne(payload, writeOptions(service));
			},

			async createMany(payloads) {
				const service = await buildService();
				return service.createMany(payloads, writeOptions(service));
			},

			async updateOne(key, payload) {
				const service = await buildService();
				return service.updateOne(key, payload, writeOptions(service));
			},

			async updateMany(keys, payload) {
				const service = await buildService();
				return service.updateMany(keys, payload, writeOptions(service));
			},

			async deleteOne(key) {
				const service = await buildService();
				return service.deleteOne(key, writeOptions(service));
			},

			async deleteMany(keys) {
				const service = await buildService();
				return service.deleteMany(keys, writeOptions(service));
			},
		};
	};
}

export const confinedItemsService: ConfinedItemsServiceFactory = createConfinedItemsService({
	database: getDatabase,
	schema: getSchema,
	service: (collection, options) => new ItemsService(collection, options),
});
