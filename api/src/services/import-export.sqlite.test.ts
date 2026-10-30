import type { SchemaOverview } from '@cairncms/types';
import type { QueueObject } from 'async';
import knex, { type Knex } from 'knex';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteAfterCreate } from '../database/connection-hooks.js';
import { installSqliteTransaction } from '../database/sqlite-transaction.js';
import emitter from '../emitter.js';
import { ImportService } from './import-export.js';

const hooks = vi.hoisted(() => ({
	writes: 0,
	drainRegistrations: 0,
	beforeWrite: undefined as ((index: number) => Promise<void> | void) | undefined,
	afterWrite: undefined as ((index: number) => void) | undefined,
	onDrainRegistered: undefined as (() => void) | undefined,
}));

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('sqlite'),
}));

vi.mock('../emitter.js', () => ({ default: { emitAction: vi.fn() } }));

vi.mock('async', async (importOriginal) => {
	const actual = await importOriginal<typeof import('async')>();
	const createQueue = actual.queue as (...args: unknown[]) => QueueObject<unknown>;

	return {
		...actual,
		queue: (...args: unknown[]) => {
			const saveQueue = createQueue(...args);
			const observed = Object.create(saveQueue) as QueueObject<unknown>;

			Object.defineProperty(observed, 'drain', {
				value: (handler: () => void) => {
					hooks.drainRegistrations++;
					hooks.onDrainRegistered?.();
					return saveQueue.drain(handler);
				},
			});

			return observed;
		},
	};
});

vi.mock('./items.js', () => ({
	ItemsService: class {
		collection: string;
		knex: Knex;

		constructor(collection: string, options: { knex: Knex }) {
			this.collection = collection;
			this.knex = options.knex;
		}

		async upsertOne(payload: Record<string, unknown>, opts: { bypassEmitAction: (params: unknown) => void }) {
			const index = hooks.writes++;

			try {
				await hooks.beforeWrite?.(index);
				await this.knex(this.collection).insert(payload);
			} finally {
				hooks.afterWrite?.(index);
			}

			opts.bypassEmitAction({ event: 'items.create', meta: { collection: this.collection, payload }, context: null });
			return payload['id'];
		}
	},
}));

type Row = Record<string, number>;

const formats = {
	csv: {
		empty: '',
		encode: (rows: Row[]) =>
			[Object.keys(rows[0]!).join(','), ...rows.map((row) => Object.values(row).join(','))].join('\n') + '\n',
		payload: (row: Row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value)])),
		run: (service: ImportService, collection: string, stream: Readable) => service.importCSV(collection, stream),
	},
	json: {
		empty: '[]',
		encode: (rows: Row[]) => JSON.stringify(rows),
		payload: (row: Row) => row,
		run: (service: ImportService, collection: string, stream: Readable) => service.importJSON(collection, stream),
	},
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => (resolve = done));
	return { promise, resolve };
}

function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function source(): Readable {
	return new Readable({ read: () => undefined });
}

describe.each(Object.entries(formats))('ImportService %s import on a real SQLite database', (_name, format) => {
	let db: Knex;
	let service: ImportService;

	beforeEach(async () => {
		vi.mocked(emitter.emitAction).mockClear();
		hooks.writes = 0;
		hooks.drainRegistrations = 0;
		hooks.beforeWrite = undefined;
		hooks.afterWrite = undefined;
		hooks.onDrainRegistered = undefined;

		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate },
		});

		installSqliteTransaction(db);

		await db.raw('create table parents (id integer primary key)');

		await db.raw(
			'create table children (id integer primary key, parent integer references parents(id) deferrable initially deferred)'
		);

		service = new ImportService({ knex: db, schema: {} as SchemaOverview, accountability: null });
	});

	afterEach(async () => {
		await db.destroy();
	});

	async function expectConnectionReusable(): Promise<void> {
		await db.transaction(async (trx) => {
			await trx('parents').insert({ id: 50 });
		});

		expect(await db('parents').pluck('id')).toEqual([50]);
	}

	it('resolves an empty import without emitting actions', async () => {
		const input = source();
		const run = format.run(service, 'parents', input);

		if (format.empty) input.push(Buffer.from(format.empty));
		input.push(null);

		await expect(run).resolves.toBeUndefined();

		expect(hooks.drainRegistrations).toBe(0);
		expect(emitter.emitAction).not.toHaveBeenCalled();
		await expectConnectionReusable();
	});

	it('saves every row and emits each action once when the writes finish before the input ends', async () => {
		const written = deferred();

		hooks.afterWrite = (index) => {
			if (index === 1) written.resolve();
		};

		const input = source();
		const run = format.run(service, 'parents', input);

		input.push(Buffer.from(format.encode([{ id: 1 }, { id: 2 }])));
		await written.promise;
		await settle();
		input.push(null);

		await expect(run).resolves.toBeUndefined();

		expect(hooks.drainRegistrations).toBe(0);
		expect(await db('parents').orderBy('id').pluck('id')).toEqual([1, 2]);

		expect(vi.mocked(emitter.emitAction).mock.calls).toEqual([
			['items.create', { collection: 'parents', payload: format.payload({ id: 1 }) }, null],
			['items.create', { collection: 'parents', payload: format.payload({ id: 2 }) }, null],
		]);
	});

	it('rolls back and emits nothing when a row fails before the input ends', async () => {
		const failed = deferred();

		hooks.afterWrite = (index) => {
			if (index === 1) failed.resolve();
		};

		const input = source();
		const run = format.run(service, 'parents', input);

		input.push(Buffer.from(format.encode([{ id: 1 }, { id: 1 }])));
		await failed.promise;
		await settle();
		input.push(null);

		await expect(run).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

		expect(hooks.drainRegistrations).toBe(0);
		expect(await db('parents').pluck('id')).toEqual([]);
		expect(emitter.emitAction).not.toHaveBeenCalled();
		await expectConnectionReusable();
	});

	it('rolls back and emits nothing when a row fails after the input ends', async () => {
		const ended = deferred();
		hooks.onDrainRegistered = ended.resolve;

		hooks.beforeWrite = async (index) => {
			if (index === 1) await ended.promise;
		};

		const input = source();
		const run = format.run(service, 'parents', input);

		input.push(Buffer.from(format.encode([{ id: 1 }, { id: 1 }])));
		input.push(null);

		await expect(run).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

		expect(hooks.drainRegistrations).toBe(1);
		expect(await db('parents').pluck('id')).toEqual([]);
		expect(emitter.emitAction).not.toHaveBeenCalled();
		await expectConnectionReusable();
	});

	it('rolls back and emits nothing when the commit fails on a deferred foreign key', async () => {
		const input = source();
		const run = format.run(service, 'children', input);

		input.push(Buffer.from(format.encode([{ id: 1, parent: 99 }])));
		input.push(null);

		await expect(run).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

		expect(await db('children').pluck('id')).toEqual([]);
		expect(emitter.emitAction).not.toHaveBeenCalled();
		await expectConnectionReusable();
	});
});
