import type { Accountability, Query, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import getDatabase from '../../database/index.js';
import { ForbiddenException } from '../../exceptions/index.js';
import { ItemsService } from '../../services/items.js';
import { getSchema } from '../../utils/get-schema.js';
import type { ConfinedItemsReader, ConfinedItemsServiceFactory } from './host-items.js';

/** The read slice of the platform items service the confined reader consumes. */
export interface ConfinedReadService {
	readByQuery(query: Query, opts: { emitEvents: boolean }): Promise<unknown>;
	readOne(key: string | number, query: Query, opts: { emitEvents: boolean }): Promise<unknown>;
}

export interface ConfinedItemsServiceDeps {
	database: () => Knex;
	schema: (options: { database: Knex }) => Promise<SchemaOverview>;
	service: (
		collection: string,
		options: { knex: Knex; schema: SchemaOverview; accountability: Accountability | null }
	) => ConfinedReadService;
}

/**
 * Builds the production items factory for the confined bindings. The service is
 * constructed per read with the current database and schema, the exact authority
 * the broker resolved (the invocation's accountability under current-user, the
 * explicit null under declared system), and every read runs with events off so a
 * brokered read never fires item read or query emissions. A collection absent
 * from the schema is refused as forbidden before the service exists, so a guest
 * cannot distinguish a collection that does not exist from one it cannot read.
 */
export function createConfinedItemsService(deps: ConfinedItemsServiceDeps): ConfinedItemsServiceFactory {
	return (collection, accountability): ConfinedItemsReader => {
		async function reader(): Promise<ConfinedReadService> {
			const knex = deps.database();
			const schema = await deps.schema({ database: knex });

			// An own-property check, because a prototype-named collection (constructor,
			// __proto__) would otherwise pass through the prototype chain and reach the
			// service as if it existed, answering internal instead of the collapse.
			if (!Object.hasOwn(schema.collections, collection)) throw new ForbiddenException();

			return deps.service(collection, { knex, schema, accountability });
		}

		return {
			async readByQuery(query) {
				return (await reader()).readByQuery(query, { emitEvents: false });
			},

			async readOne(key, query) {
				return (await reader()).readOne(key, query, { emitEvents: false });
			},
		};
	};
}

export const confinedItemsService: ConfinedItemsServiceFactory = createConfinedItemsService({
	database: getDatabase,
	schema: getSchema,
	service: (collection, options) => new ItemsService(collection, options),
});
