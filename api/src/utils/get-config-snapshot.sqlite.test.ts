import type { SchemaOverview } from '@cairncms/types';
import { promises as fs } from 'fs';
import knex, { type Knex } from 'knex';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigSchemaCollection } from '../types/config.js';
import { readConfigDirectory } from './read-config-directory.js';
import { readCurrentConfig } from './get-config-snapshot.js';
import { version } from './package.js';
import { validateConfigManifest } from './validate-desired-config.js';
import { writeConfigDirectory } from './write-config-directory.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('sqlite'),
}));

vi.mock('../env', async () => {
	const actual = (await vi.importActual('../env')) as { default: Record<string, unknown> };
	const MOCK_ENV = { ...actual.default, DB_EXCLUDE_TABLES: ['spatial_ref_sys'] };
	return { default: MOCK_ENV, getEnv: () => MOCK_ENV };
});

const FOLDER_ID = '11111111-1111-4111-8111-111111111111';

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
		directus_collections: {
			collection: 'directus_collections',
			primary: 'collection',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				collection: field('collection', 'string', { nullable: false }),
				note: field('note', 'text'),
				hidden: field('hidden', 'boolean', { special: ['cast-boolean'] }),
				singleton: field('singleton', 'boolean', { special: ['cast-boolean'] }),
				icon: field('icon', 'string'),
				translations: field('translations', 'json', { special: ['cast-json'] }),
				display_template: field('display_template', 'string'),
				sort: field('sort', 'integer'),
				color: field('color', 'string'),
				group: field('group', 'string'),
				accountability: field('accountability', 'string'),
			},
		},
		directus_fields: {
			collection: 'directus_fields',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'integer', { nullable: false }),
				collection: field('collection', 'string'),
				field: field('field', 'string'),
				special: field('special', 'csv', { special: ['cast-csv'] }),
				interface: field('interface', 'string'),
				options: field('options', 'json', { special: ['cast-json'] }),
				note: field('note', 'text'),
				validation: field('validation', 'json', { special: ['cast-json'] }),
			},
		},
		directus_relations: {
			collection: 'directus_relations',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'integer', { nullable: false }),
				many_collection: field('many_collection', 'string'),
				many_field: field('many_field', 'string'),
				one_collection: field('one_collection', 'string'),
				one_field: field('one_field', 'string'),
			},
		},
		articles: {
			collection: 'articles',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'integer', { nullable: false }),
				title: field('title', 'string'),
				hero: field('hero', 'uuid'),
				author: field('author', 'uuid'),
				label_code: field('label_code', 'string'),
				geo: field('geo', 'integer'),
			},
		},
		directus_users: {
			collection: 'directus_users',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'uuid', { nullable: false }),
				bio: field('bio', 'text'),
			},
		},
	},
	relations: [],
} as unknown as SchemaOverview;

describe('readCurrentConfig schema on a real SQLite database', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 500,
		});

		await db.schema.createTable('directus_collections', (table) => {
			table.string('collection').primary();
			table.text('note');
			table.boolean('hidden');
			table.boolean('singleton');
			table.string('icon');
			table.json('translations');
			table.string('display_template');
			table.integer('sort');
			table.string('color');
			table.string('group');
			table.string('accountability');
		});

		await db.schema.createTable('directus_fields', (table) => {
			table.increments('id');
			table.string('collection');
			table.string('field');
			table.string('special');
			table.string('interface');
			table.json('options');
			table.text('note');
			table.json('validation');
		});

		await db.schema.createTable('directus_relations', (table) => {
			table.increments('id');
			table.string('many_collection');
			table.string('many_field');
			table.string('one_collection');
			table.string('one_field');
		});

		await db.schema.createTable('directus_folders', (table) => {
			table.uuid('id').primary();
			table.string('key');
		});

		await db.schema.createTable('articles', (table) => {
			table.increments('id');
			table.string('title');
			table.uuid('hero');
			table.uuid('author');
			table.string('label_code');
			table.integer('geo');
		});

		await db.schema.createTable('directus_users', (table) => {
			table.uuid('id').primary();
			table.text('bio');
		});

		// An unconfigured table with no primary key: absent from the schema overview, captured by the snapshot.
		await db.schema.createTable('native_labels', (table) => {
			table.string('code');
		});

		// Excluded by DB_EXCLUDE_TABLES, but still the target of a relation the writer must drop.
		await db.schema.createTable('spatial_ref_sys', (table) => {
			table.integer('srid');
		});

		await db('directus_collections').insert([
			{
				collection: 'articles',
				note: 'Articles',
				hidden: false,
				singleton: false,
				icon: 'article',
				translations: JSON.stringify([
					{ language: 'en-US', translation: 'Articles', singular: 'Article', plural: 'Articles' },
				]),
				display_template: '{{title}}',
				sort: 2,
				color: '#3399ff',
				group: null,
				accountability: 'all',
			},
			{ collection: 'directus_users', note: 'Operator customized', hidden: false, singleton: false, icon: null },
		]);

		await db('directus_fields').insert([
			{ collection: 'articles', field: 'title', interface: 'input' },
			{
				collection: 'articles',
				field: 'hero',
				interface: 'file-image',
				options: JSON.stringify({ folder: FOLDER_ID }),
			},
			{ collection: 'directus_users', field: 'bio', interface: 'input-multiline' },
		]);

		await db('directus_relations').insert([
			{ many_collection: 'articles', many_field: 'author', one_collection: 'directus_users' },
			{ many_collection: 'articles', many_field: 'geo', one_collection: 'spatial_ref_sys' },
			{ many_collection: 'articles', many_field: 'label_code', one_collection: 'native_labels' },
		]);

		await db('directus_folders').insert({ id: FOLDER_ID, key: 'media' });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await db.destroy();
	});

	async function readSchema(): Promise<ConfigSchemaCollection[]> {
		const { config } = await readCurrentConfig({ database: db, schema, resources: ['schema'], manifestVersion: 3 });
		return config.schema;
	}

	async function readDigest(): Promise<string> {
		const { stateToken } = await readCurrentConfig({ database: db, schema, resources: ['schema'], manifestVersion: 3 });
		return stateToken.digest;
	}

	it('captures configured, unconfigured, and system collections from the real services', async () => {
		const result = await readSchema();

		expect(result.map((record) => record.collection)).toEqual(['articles', 'directus_users', 'native_labels']);

		const articles = result[0]!;

		expect(articles.meta).toEqual({
			collection: 'articles',
			note: 'Articles',
			hidden: false,
			singleton: false,
			icon: 'article',
			translations: [{ language: 'en-US', translation: 'Articles', singular: 'Article', plural: 'Articles' }],
			display_template: '{{title}}',
			sort: 2,
			color: '#3399ff',
			group: null,
			accountability: 'all',
		});

		expect(articles.schema).toMatchObject({ name: 'articles' });
		expect(articles.fields.map((entry) => entry.field)).toEqual(['author', 'geo', 'hero', 'id', 'label_code', 'title']);

		const title = articles.fields.find((entry) => entry.field === 'title')!;
		expect(title.meta).not.toBeNull();
		expect(title.meta).not.toHaveProperty('id');

		const users = result[1]!;
		expect(users).not.toHaveProperty('meta');
		expect(users).not.toHaveProperty('schema');
		expect(users.fields.map((entry) => entry.field)).toEqual(['bio']);

		const labels = result[2]!;
		expect(labels.meta).toBeNull();
	});

	it('drops a relation into an excluded target and keeps the others', async () => {
		const result = await readSchema();

		expect(result.map((record) => record.collection)).not.toContain('spatial_ref_sys');
		expect(result[0]!.relations.map((relation) => relation.field)).toEqual(['author', 'label_code']);
	});

	it('rewrites a folder-valued field option to its folder key', async () => {
		const result = await readSchema();
		const hero = result[0]!.fields.find((entry) => entry.field === 'hero')!;

		expect((hero.meta as { options: { folder: string } }).options.folder).toBe('media');
	});

	it('refuses a field whose folder reference cannot be resolved', async () => {
		await db('directus_folders').where({ id: FOLDER_ID }).del();

		await expect(readSchema()).rejects.toThrow(
			`Field "articles.hero" references folder "${FOLDER_ID}" at meta.options.folder, which does not exist. Select another folder for this field and take the snapshot again.`
		);
	});

	it('produces a stable state digest that changes with a collection, field, or relation edit', async () => {
		const base = await readDigest();
		expect(await readDigest()).toBe(base);

		await db('directus_collections').where({ collection: 'articles' }).update({ note: 'Changed' });
		const afterCollection = await readDigest();
		expect(afterCollection).not.toBe(base);

		await db('directus_fields').where({ collection: 'articles', field: 'title' }).update({ note: 'Headline' });
		const afterField = await readDigest();
		expect(afterField).not.toBe(afterCollection);

		await db('directus_relations').where({ many_field: 'author' }).update({ one_field: 'posts' });
		expect(await readDigest()).not.toBe(afterField);
	});

	it('records the source release and vendor in the manifest, valid on its next read', async () => {
		const { config } = await readCurrentConfig({ database: db, schema, resources: ['schema'], manifestVersion: 3 });

		expect(config.manifest.schema).toEqual({ release: version, vendor: 'sqlite' });
		expect(() => validateConfigManifest(config.manifest, 'snapshot')).not.toThrow();
	});

	it('round-trips a written snapshot back through the reader with provenance intact', async () => {
		const { config } = await readCurrentConfig({ database: db, schema, resources: ['schema'], manifestVersion: 3 });

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-schema-roundtrip-'));

		try {
			await writeConfigDirectory(config, dir);
			const readBack = await readConfigDirectory(dir);

			expect(readBack.schema).toEqual(config.schema);
			expect(readBack.manifest.schema).toEqual(config.manifest.schema);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
