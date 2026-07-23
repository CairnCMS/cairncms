import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { describe, expect, it, vi } from 'vitest';
import { getInternalTables } from '../../database/internal-tables.js';
import type { MutationTracker } from '../../services/items.js';
import type { ConfinedItemsWriter } from './host-items.js';
import {
	CONFINED_WRITE_MAX_MUTATIONS,
	createConfinedItemsService,
	type ConfinedItemsServiceDeps,
} from './items-service.js';

type ServiceCall = {
	collection: string;
	accountability: Accountability | null;
	method: string;
	args: unknown[];
};

type TrackerCall = {
	collection: string;
	initialCount: number;
	options: { maxCount: number };
	tracker: MutationTracker;
};

function harness(collections: string[] = ['articles']) {
	const calls: ServiceCall[] = [];
	const trackerCalls: TrackerCall[] = [];
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
		service: (collection, options) => {
			const record = (method: string, args: unknown[]) => {
				calls.push({ collection, accountability: options.accountability, method, args });
			};

			return {
				async readByQuery(...args) {
					record('readByQuery', args);
					return [{ id: 1 }];
				},
				async readOne(...args) {
					record('readOne', args);
					return { id: 1 };
				},
				async createOne(...args) {
					record('createOne', args);
					return 1;
				},
				async createMany(...args) {
					record('createMany', args);
					return [1, 2];
				},
				async updateOne(...args) {
					record('updateOne', args);
					return 3;
				},
				async updateMany(...args) {
					record('updateMany', args);
					return [3, 4];
				},
				async deleteOne(...args) {
					record('deleteOne', args);
					return 5;
				},
				async deleteMany(...args) {
					record('deleteMany', args);
					return [5, 6];
				},
				createMutationTracker(initialCount, trackerOptions) {
					const tracker: MutationTracker = { trackMutations: vi.fn(), getCount: () => 0 };
					trackerCalls.push({ collection, initialCount, options: trackerOptions, tracker });
					return tracker;
				},
			};
		},
	};

	return { factory: createConfinedItemsService(deps), calls, trackerCalls, schemaReads: () => schemaReads };
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

	it('writes pass the current-user accountability through to the service', async () => {
		const { factory, calls } = harness();
		const accountability = { user: 'u-1', role: 'r-1', admin: false } as Accountability;

		await factory('articles', accountability).createOne({ title: 'x' });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe('createOne');
		expect(calls[0]?.accountability).toBe(accountability);
		expect(calls[0]?.args[0]).toEqual({ title: 'x' });
	});

	it('forwards each write verb to the service and returns its result', async () => {
		const cases: Array<{
			method: string;
			invoke: (writer: ConfinedItemsWriter) => Promise<unknown>;
			forwarded: unknown[];
			expected: unknown;
		}> = [
			{ method: 'createOne', invoke: (w) => w.createOne({ a: 1 }), forwarded: [{ a: 1 }], expected: 1 },
			{
				method: 'createMany',
				invoke: (w) => w.createMany([{ a: 1 }, { a: 2 }]),
				forwarded: [[{ a: 1 }, { a: 2 }]],
				expected: [1, 2],
			},
			{ method: 'updateOne', invoke: (w) => w.updateOne(7, { a: 1 }), forwarded: [7, { a: 1 }], expected: 3 },
			{
				method: 'updateMany',
				invoke: (w) => w.updateMany([7, 8], { a: 1 }),
				forwarded: [[7, 8], { a: 1 }],
				expected: [3, 4],
			},
			{ method: 'deleteOne', invoke: (w) => w.deleteOne(7), forwarded: [7], expected: 5 },
			{ method: 'deleteMany', invoke: (w) => w.deleteMany([7, 8]), forwarded: [[7, 8]], expected: [5, 6] },
		];

		for (const testCase of cases) {
			const { factory, calls, trackerCalls } = harness();

			const result = await testCase.invoke(factory('articles', null));

			expect(result).toEqual(testCase.expected);
			expect(calls).toHaveLength(1);
			const call = calls[0]!;
			expect(call.method).toBe(testCase.method);
			expect(call.args.slice(0, -1)).toEqual(testCase.forwarded);

			expect(trackerCalls).toHaveLength(1);
			expect(trackerCalls[0]).toMatchObject({ initialCount: 0, options: { maxCount: CONFINED_WRITE_MAX_MUTATIONS } });

			const opts = call.args[call.args.length - 1] as { mutationTracker: unknown; emitEvents: boolean };
			expect(opts.emitEvents).toBe(true);
			expect(opts.mutationTracker).toBe(trackerCalls[0]!.tracker);
		}
	});

	it('refuses every write verb on a directus_* system collection before the service exists', async () => {
		const { factory, calls, trackerCalls } = harness(['articles', 'directus_users']);
		const writer = factory('directus_users', null);

		await expect(writer.createOne({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(writer.createMany([{}])).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(writer.updateOne(1, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(writer.updateMany([1], {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(writer.deleteOne(1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
		await expect(writer.deleteMany([1])).rejects.toMatchObject({ code: 'FORBIDDEN' });

		expect(calls).toHaveLength(0);
		expect(trackerCalls).toHaveLength(0);
	});
});
