import type { DeepPartial, SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	CairnConfig,
	ConfigApplySecurityContext,
	ConfigFolder,
	ConfigKind,
	ConfigManifest,
	ConfigSchemaCollection,
} from '../types/config.js';
import type { SnapshotField } from '../types/index.js';
import { applyFolderPreparation } from './apply-folder-preparation.js';
import { kindsForVersion } from './config/registry.js';
import { normalizeToInternal } from './config/wire.js';
import { referencedFolderKeys } from './folder-references.js';
import { validateDesiredConfig } from './validate-desired-config.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: () => 'sqlite',
}));

vi.mock('../cache.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../cache.js')>()),
	flushCaches: vi.fn(async () => undefined),
}));

function schemaField(name: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
				id: schemaField('id', 'uuid', { nullable: false, special: ['uuid'] }),
				name: schemaField('name', 'string', { nullable: false }),
				parent: schemaField('parent', 'uuid'),
				key: schemaField('key', 'string', { special: ['folder-key'] }),
			},
		},
	},
	relations: [],
} as unknown as SchemaOverview;

const securityContext: ConfigApplySecurityContext = {
	mode: 'system',
	reason: 'local config apply',
	accountability: { user: null, role: null, admin: true, app: true, permissions: [], origin: 'config-cli' } as never,
};

function uploadField(name: string, folderKey: string, options: { omitInterface?: boolean } = {}): SnapshotField {
	const meta: DeepPartial<SnapshotField['meta']> = { options: { folder: folderKey } };
	if (options.omitInterface !== true) (meta as Record<string, unknown>)['interface'] = 'file';

	const draft: DeepPartial<SnapshotField> = { collection: 'articles', field: name, type: 'uuid', schema: null, meta };
	return draft as SnapshotField;
}

function plainField(name: string): SnapshotField {
	const draft: DeepPartial<SnapshotField> = {
		collection: 'articles',
		field: name,
		type: 'string',
		schema: null,
		meta: { interface: 'input' },
	};

	return draft as SnapshotField;
}

function articleSchema(fields: SnapshotField[]): ConfigSchemaCollection[] {
	const draft: DeepPartial<ConfigSchemaCollection> = { collection: 'articles', meta: {}, fields, relations: [] };
	return [draft as ConfigSchemaCollection];
}

function folder(key: string, parent: string | null = null): ConfigFolder {
	return { key, name: key, parent };
}

function buildDesired(
	resources: ConfigKind[],
	body: { folders?: ConfigFolder[]; schema?: ConfigSchemaCollection[] }
): CairnConfig {
	const manifest: ConfigManifest = { version: 3, resources };

	const document: Record<string, unknown> = { manifest };

	for (const kind of kindsForVersion(manifest.version)) {
		document[kind] = (body as Record<string, unknown>)[kind] ?? [];
	}

	const failures = validateDesiredConfig(document, {
		label: 'folder preparation fixture',
		references: 'current-state',
		currentRoleKeys: new Set<string>(),
		currentFolderKeys: new Set<string>(),
	});

	expect(failures).toEqual([]);

	return normalizeToInternal(manifest, document);
}

describe('folder preparation through the real apply engine on SQLite', () => {
	let db: Knex;
	let serial: number;

	function nextId(): string {
		serial += 1;
		return `00000000-0000-4000-8000-${serial.toString(16).padStart(12, '0')}`;
	}

	beforeEach(async () => {
		serial = 0;

		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 1000,
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
			table.string('interface');
			table.text('options');
			table.text('conditions');
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	async function tree(): Promise<Record<string, string | null>> {
		const rows = await db('directus_folders').select('id', 'key', 'parent');
		const keyById = new Map(rows.map((row) => [row.id, row.key]));
		return Object.fromEntries(rows.map((row) => [row.key, row.parent === null ? null : keyById.get(row.parent)!]));
	}

	async function seed(entries: Array<{ key: string; parent: string | null }>): Promise<void> {
		const idByKey = new Map<string, string>();
		for (const entry of entries) idByKey.set(entry.key, nextId());

		for (const entry of entries) {
			await db('directus_folders').insert({
				id: idByKey.get(entry.key),
				name: entry.key,
				key: entry.key,
				parent: entry.parent === null ? null : idByKey.get(entry.parent),
			});
		}
	}

	function run(desired: CairnConfig, currentSchema: ConfigSchemaCollection[] = []): Promise<readonly string[]> {
		return applyFolderPreparation(desired, currentSchema, { database: db, schema, context: securityContext });
	}

	it('creates a referenced folder the target lacks', async () => {
		const desired = buildDesired(['folders', 'schema'], {
			folders: [folder('uploads')],
			schema: articleSchema([uploadField('cover', 'uploads')]),
		});

		expect(await run(desired)).toEqual(['uploads']);
		expect(await tree()).toEqual({ uploads: null });
	});

	it('creates a chain of new parents before the referenced folder', async () => {
		const desired = buildDesired(['folders', 'schema'], {
			folders: [folder('leaf', 'branch'), folder('branch', 'root'), folder('root')],
			schema: articleSchema([uploadField('cover', 'leaf')]),
		});

		expect(await run(desired)).toEqual(['root', 'branch', 'leaf']);
		expect(await tree()).toEqual({ root: null, branch: 'root', leaf: 'branch' });
	});

	it('stops the ancestor walk at a parent already on the target', async () => {
		await seed([{ key: 'root', parent: null }]);

		const desired = buildDesired(['folders', 'schema'], {
			folders: [folder('child', 'root'), folder('root')],
			schema: articleSchema([uploadField('cover', 'child')]),
		});

		expect(await run(desired)).toEqual(['child']);
		expect(await tree()).toEqual({ root: null, child: 'root' });
	});

	it('neither creates nor reparents a referenced folder already present', async () => {
		await seed([
			{ key: 'root', parent: null },
			{ key: 'uploads', parent: 'root' },
		]);

		const desired = buildDesired(['folders', 'schema'], {
			folders: [folder('uploads')],
			schema: articleSchema([uploadField('cover', 'uploads')]),
		});

		expect(await run(desired)).toEqual([]);
		expect(await tree()).toEqual({ root: null, uploads: 'root' });
	});

	it('prepares nothing when the schema references no folder', async () => {
		const desired = buildDesired(['folders', 'schema'], {
			folders: [folder('uploads')],
			schema: articleSchema([plainField('title')]),
		});

		expect(await run(desired)).toEqual([]);
		expect(await tree()).toEqual({});
	});

	it('sees a reference only after an omitted interface is reconciled from the current schema', async () => {
		const cover = uploadField('cover', 'fresh', { omitInterface: true });
		expect(cover.meta).not.toHaveProperty('interface');
		expect(referencedFolderKeys([cover])).toEqual(new Set());

		const desired = buildDesired(['folders', 'schema'], {
			folders: [folder('fresh')],
			schema: articleSchema([cover]),
		});

		expect(await run(desired)).toEqual([]);
		expect(await tree()).toEqual({});

		const currentSchema = articleSchema([uploadField('cover', 'legacy')]);
		expect(await run(desired, currentSchema)).toEqual(['fresh']);
		expect(await tree()).toEqual({ fresh: null });
	});

	it('creates nothing from a folders payload supplied without folders managed', async () => {
		const desired = buildDesired(['schema'], {
			folders: [folder('uploads')],
			schema: articleSchema([uploadField('cover', 'uploads')]),
		});

		expect(desired.folders).toEqual([]);
		expect(await run(desired)).toEqual([]);
		expect(await tree()).toEqual({});
	});
});
