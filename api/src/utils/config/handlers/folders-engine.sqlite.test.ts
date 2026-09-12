import type { SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { FoldersService } from '../../../services/folders.js';
import type { ConfigFolder } from '../../../types/config.js';
import type { ApplyContext, ReadContext } from '../descriptor.js';
import { foldersDescriptor, type FoldersKindTypes } from './folders.js';

vi.mock('../../../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('sqlite'),
}));

function field(name: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: type,
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: false,
		...extra,
	};
}

const schema = {
	collections: {
		directus_folders: {
			collection: 'directus_folders',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'uuid', { nullable: false, special: ['uuid'] }),
				name: field('name', 'string', { nullable: false }),
				parent: field('parent', 'uuid'),
				key: field('key', 'string', { special: ['folder-key'] }),
			},
		},
	},
	relations: [],
} as unknown as SchemaOverview;

const accountability = { user: null, role: null, admin: true, app: true, permissions: [], origin: 'config-cli' };

function applyContext(db: Knex): ApplyContext<FoldersKindTypes> {
	return {
		database: db,
		schema,
		securityContext: { mode: 'system', reason: 'local config apply', accountability: accountability as never },
		mutationOptions: {
			autoPurgeCache: false,
			autoPurgeSystemCache: false,
			bypassLimits: true,
			bypassEmitAction: () => undefined,
		},
		dependency: (() => undefined) as never,
	};
}

function folder(key: string, parent: string | null = null): ConfigFolder {
	return { key, name: key, parent };
}

describe('folders handler against a real SQLite database', () => {
	let db: Knex;
	let uuidByKey: Map<string, string>;
	const spies: MockInstance[] = [];

	function idFor(key: string): string {
		if (!uuidByKey.has(key)) {
			const hex = (uuidByKey.size + 1).toString(16).padStart(12, '0');
			uuidByKey.set(key, `00000000-0000-4000-8000-${hex}`);
		}

		return uuidByKey.get(key)!;
	}

	beforeEach(async () => {
		uuidByKey = new Map();

		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 500,
		});

		await db.schema.createTable('directus_folders', (table) => {
			table.uuid('id').primary();
			table.string('name');
			table.uuid('parent');
			table.string('key').unique();
		});

		await db.schema.createTable('directus_files', (table) => {
			table.uuid('id').primary();
			table.uuid('folder');
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.uuid('storage_default_folder');
		});

		await db.schema.createTable('directus_fields', (table) => {
			table.increments('id');
			table.text('options');
		});
	});

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		await db.destroy();
	});

	async function tree(): Promise<Record<string, string | null>> {
		const rows = await db('directus_folders').select('id', 'key', 'parent');
		const keyById = new Map(rows.map((row) => [row.id, row.key]));
		return Object.fromEntries(rows.map((row) => [row.key, row.parent === null ? null : keyById.get(row.parent)!]));
	}

	async function seed(entries: Array<{ key: string; parent: string | null }>): Promise<void> {
		for (const entry of entries) {
			await db('directus_folders').insert({
				id: idFor(entry.key),
				name: entry.key,
				key: entry.key,
				parent: entry.parent === null ? null : idFor(entry.parent),
			});
		}
	}

	it('creates a multilevel tree parent-before-child and generates each key', async () => {
		await foldersDescriptor.handler.applyCreates(
			[folder('child', 'root'), folder('root'), folder('grandchild', 'child')],
			applyContext(db)
		);

		expect(await tree()).toEqual({ root: null, child: 'root', grandchild: 'child' });
	});

	it('creates a root when the parent is omitted', async () => {
		await foldersDescriptor.handler.applyCreates([{ key: 'root', name: 'Root' } as ConfigFolder], applyContext(db));

		expect(await tree()).toEqual({ root: null });
	});

	it('reparents through unchanged ancestors, writing each changed folder once in ancestor order', async () => {
		await seed([
			{ key: 'a', parent: null },
			{ key: 'b', parent: 'a' },
			{ key: 'c', parent: 'b' },
		]);

		const order: string[] = [];
		const original = FoldersService.prototype.updateOne;

		spies.push(
			vi
				.spyOn(FoldersService.prototype, 'updateOne')
				.mockImplementation(async function (this: FoldersService, id, data, opts) {
					order.push(id as string);
					return original.call(this, id, data, opts);
				})
		);

		await foldersDescriptor.handler.applyUpdates(
			[
				{ key: 'a', changes: { parent: { before: null, after: 'c' } } },
				{ key: 'b', changes: { parent: { before: 'a', after: null } } },
			],
			applyContext(db)
		);

		expect(order).toEqual([idFor('b'), idFor('a')]);
		expect(await tree()).toEqual({ a: 'c', b: null, c: 'b' });
	});

	it('deletes children before their parents', async () => {
		await seed([
			{ key: 'parent', parent: null },
			{ key: 'child', parent: 'parent' },
		]);

		const order: string[] = [];
		const original = FoldersService.prototype.deleteOne;

		spies.push(
			vi
				.spyOn(FoldersService.prototype, 'deleteOne')
				.mockImplementation(async function (this: FoldersService, id, opts) {
					order.push(id as string);
					return original.call(this, id, opts);
				})
		);

		await foldersDescriptor.handler.applyDeletes(['parent', 'child'], applyContext(db));

		expect(order).toEqual([idFor('child'), idFor('parent')]);
		expect(await tree()).toEqual({});
	});

	it('reads the current tree back with parents referenced by key', async () => {
		await seed([
			{ key: 'root', parent: null },
			{ key: 'child', parent: 'root' },
		]);

		const result = await foldersDescriptor.handler.readCurrent({
			database: db,
			schema,
			readMode: 'full',
			dependency: (() => undefined) as never,
		} as ReadContext<FoldersKindTypes>);

		expect(result.records).toEqual([
			{ key: 'child', name: 'child', parent: 'root' },
			{ key: 'root', name: 'root', parent: null },
		]);
	});
});
