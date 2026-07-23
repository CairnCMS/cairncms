import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { describe, expect, it } from 'vitest';
import { getInternalTables } from '../../database/internal-tables.js';
import { createConfinedItemsService, type ConfinedItemsServiceDeps } from './items-service.js';

type ServiceCall = {
	collection: string;
	accountability: Accountability | null;
	method: string;
	args: unknown[];
};

function harness(collections: string[] = ['articles']) {
	const calls: ServiceCall[] = [];
	let schemaReads = 0;

	const schema = {
		collections: Object.fromEntries(collections.map((name) => [name, { collection: name, primary: 'id' }])),
		relations: [],
	} as unknown as SchemaOverview;

	const deps: ConfinedItemsServiceDeps = {
		database: () => ({} as Knex),
		schema: async () => {
			schemaReads += 1;
			return schema;
		},
		service: (collection, options) => ({
			async readByQuery(...args) {
				calls.push({ collection, accountability: options.accountability, method: 'readByQuery', args });
				return [{ id: 1 }];
			},
			async readOne(...args) {
				calls.push({ collection, accountability: options.accountability, method: 'readOne', args });
				return { id: 1 };
			},
		}),
	};

	return { factory: createConfinedItemsService(deps), calls, schemaReads: () => schemaReads };
}

describe('createConfinedItemsService', () => {
	it('reads with events off and the exact current-user accountability', async () => {
		const { factory, calls } = harness();
		const accountability = { user: 'u-1', role: 'r-1', admin: false } as Accountability;

		await factory('articles', accountability).readByQuery({ limit: 1 });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.accountability).toBe(accountability);
		expect(calls[0]?.args).toEqual([{ limit: 1 }, { emitEvents: false }]);
	});

	it('reads with the explicit null authority under declared system', async () => {
		const { factory, calls } = harness();

		await factory('articles', null).readOne(42, {});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.accountability).toBeNull();
		expect(calls[0]?.method).toBe('readOne');
		expect(calls[0]?.args).toEqual([42, {}, { emitEvents: false }]);
	});

	it('resolves a fresh schema and service per read call', async () => {
		const { factory, calls, schemaReads } = harness();
		const reader = factory('articles', null);

		await reader.readByQuery({});
		await reader.readByQuery({});

		expect(schemaReads()).toBe(2);
		expect(calls).toHaveLength(2);
	});

	it('refuses a collection absent from the schema as forbidden before the service exists', async () => {
		const { factory, calls } = harness(['articles']);

		await expect(factory('not_a_collection', null).readByQuery({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(factory('not_a_collection', null).readOne(1, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(calls).toHaveLength(0);
	});

	it('refuses a prototype-named collection rather than resolving it through the prototype chain', async () => {
		const { factory, calls } = harness(['articles']);

		for (const collection of ['constructor', '__proto__', 'hasOwnProperty']) {
			await expect(factory(collection, null).readByQuery({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
			await expect(factory(collection, null).readOne(1, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		}

		expect(calls).toHaveLength(0);
	});

	it('reads a real collection that happens to carry a prototype name', async () => {
		const { factory, calls } = harness(['constructor']);

		await factory('constructor', null).readByQuery({});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.collection).toBe('constructor');
	});

	it('refuses a directus_* system collection before the service exists, even when it is in the schema', async () => {
		const { factory, calls } = harness(['articles', 'directus_users', 'directus_roles']);

		for (const collection of ['directus_users', 'directus_roles']) {
			await expect(factory(collection, null).readByQuery({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
			await expect(factory(collection, null).readOne(1, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		}

		expect(calls).toHaveLength(0);
	});

	it('refuses a registered internal table before the service exists, even when it is in the schema', async () => {
		const internal = getInternalTables();
		expect(internal.length).toBeGreaterThan(0);

		const { factory, calls } = harness(['articles', ...internal]);

		for (const collection of internal) {
			await expect(factory(collection, null).readByQuery({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
			await expect(factory(collection, null).readOne(1, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		}

		expect(calls).toHaveLength(0);
	});
});
