import { createInspector } from '@cairncms/schema';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionsService } from '../../services/collections.js';
import type { ConfigSchemaCollection } from '../../types/config.js';
import type { SnapshotField } from '../../types/index.js';
import { computeSchemaPlan } from './handlers/schema.js';
import { projectCollections } from './projected-collections.js';

vi.mock('../../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: () => 'sqlite',
	getSchemaInspector: vi.fn(),
}));

vi.mock('../../cache.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../cache.js')>()),
	getCache: () => ({ cache: null, systemCache: null, localSchemaCache: null, lockCache: null }),
	clearSystemCache: vi.fn(async () => undefined),
}));

const PROBE = 'probe';

function probeField(field: string, type: string, schema: Record<string, unknown>): SnapshotField {
	return { collection: PROBE, field, type, meta: null, schema: { name: field, ...schema } } as unknown as SnapshotField;
}

const title = probeField('title', 'string', { is_primary_key: false, has_auto_increment: false });

describe('projectCollections against the collection writer on SQLite', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

		await db.schema.createTable('directus_collections', (table) => {
			table.string('collection').primary();
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it.each([
		['an unknown-typed field flagged as the primary key', probeField('id', 'unknown', { is_primary_key: true }), false],
		[
			'an auto-incrementing field not flagged as the primary key',
			probeField('id', 'integer', { is_primary_key: false, has_auto_increment: true }),
			true,
		],
		['an integer field flagged as the primary key', probeField('id', 'integer', { is_primary_key: true }), true],
		['a string field flagged as the primary key', probeField('id', 'string', { is_primary_key: true }), true],
		['an alias field flagged as the primary key', probeField('id', 'o2m', { is_primary_key: true }), false],
	])('admits a created collection exactly when the writer gives it a primary key: %s', async (_case, key, keyed) => {
		await new CollectionsService({ knex: db, schema: { collections: {}, relations: [] } }).createOne(
			{ collection: PROBE, schema: { name: PROBE }, meta: null, fields: [key, title] } as never,
			{ autoPurgeCache: false, autoPurgeSystemCache: false, emitEvents: false }
		);

		const overview = await createInspector(db).overview();
		expect(Boolean(overview[PROBE]?.primary)).toBe(keyed);

		const desired: ConfigSchemaCollection = {
			collection: PROBE,
			meta: null,
			schema: { name: PROBE } as Exclude<ConfigSchemaCollection['schema'], undefined>,
			fields: [key, title],
			relations: [],
		};

		const projected = projectCollections({}, computeSchemaPlan([], [desired], []));

		expect(projected.has(PROBE)).toBe(keyed);
	});
});
