import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotField } from '../types/index.js';
import { isFolderKey, toFolderIds, toKeyFormSnapshot, validateFolderReferences } from './folder-references.js';
import { getVersionedHash } from './get-versioned-hash.js';

const IMAGES = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DOCS = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const REPLACEMENT = 'cccccccc-3333-4333-8333-cccccccccccc';

function field(name: string, meta: Record<string, unknown>): SnapshotField {
	return { collection: 'articles', field: name, type: 'uuid', schema: null, meta } as unknown as SnapshotField;
}

function snapshot(fields: SnapshotField[]): Snapshot {
	return { version: 1, directus: '1.0.0', collections: [], fields, relations: [] };
}

describe('isFolderKey', () => {
	it('accepts keys and rejects IDs and other values', () => {
		expect(isFolderKey('images')).toBe(true);
		expect(isFolderKey('article_images_2')).toBe(true);
		expect(isFolderKey(IMAGES)).toBe(false);
		expect(isFolderKey('Images')).toBe(false);
		expect(isFolderKey('2images')).toBe(false);
		expect(isFolderKey('')).toBe(false);
		expect(isFolderKey(null)).toBe(false);
	});
});

describe('toFolderIds', () => {
	const folderIdByKey = new Map([['images', IMAGES]]);

	it('replaces keys with IDs at their storage paths and leaves raw IDs alone', () => {
		const original = field('body', {
			interface: 'list',
			options: { fields: [{ meta: { interface: 'input-rich-text-md', options: { folder: 'images' } } }] },
			conditions: [{ name: 'a', rule: {}, options: { fields: [{ meta: { options: { folder: DOCS } } }] } }],
		});

		const translated = toFolderIds(original, folderIdByKey);

		expect((translated.meta as any).options.fields[0].meta.options.folder).toBe(IMAGES);
		expect((translated.meta as any).conditions[0].options.fields[0].meta.options.folder).toBe(DOCS);
		expect((original.meta as any).options.fields[0].meta.options.folder).toBe('images');
	});

	it('refuses a missing key with the full path', () => {
		const original = field('body', {
			interface: 'list',
			options: { fields: [{ meta: { interface: 'input-rich-text-md', options: { folder: 'missing' } } }] },
		});

		expect(() => toFolderIds(original, folderIdByKey)).toThrow(
			'Folder reference "missing" could not be resolved. Referenced by: articles.body.meta.options.fields[0].meta.options.folder'
		);
	});
});

describe('validateFolderReferences', () => {
	const folderIdByKey = new Map([['images', IMAGES]]);

	it('accepts existing keys and null', () => {
		expect(() =>
			validateFolderReferences(
				[
					field('image', { interface: 'file', options: { folder: 'images' } }),
					field('cover', { interface: 'file', options: { folder: null } }),
				],
				folderIdByKey
			)
		).not.toThrow();
	});

	it('refuses a value that is not a key', () => {
		expect(() =>
			validateFolderReferences([field('image', { interface: 'file', options: { folder: IMAGES } })], folderIdByKey)
		).toThrow(`Folder reference "${IMAGES}" at articles.image.meta.options.folder is not a folder key.`);
	});

	it('refuses a key with no folder', () => {
		expect(() =>
			validateFolderReferences([field('image', { interface: 'file', options: { folder: 'docs' } })], folderIdByKey)
		).toThrow('Folder reference "docs" could not be resolved. Referenced by: articles.image.meta.options.folder');
	});
});

describe('toKeyFormSnapshot on a real SQLite database', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
		await db.raw('CREATE TABLE directus_folders (id TEXT PRIMARY KEY COLLATE NOCASE, key TEXT, name TEXT)');

		await db('directus_folders').insert([
			{ id: IMAGES, key: 'images', name: 'Images' },
			{ id: DOCS, key: 'docs', name: 'Docs' },
		]);
	});

	afterEach(async () => {
		await db.destroy();
	});

	const uploads = (folder: string) => snapshot([field('image', { interface: 'file', options: { folder } })]);

	const hashOf = async (current: Snapshot) =>
		getVersionedHash((await toKeyFormSnapshot(current, { database: db })).snapshot);

	it('replaces folder IDs with keys, including a differently cased ID', async () => {
		const { snapshot: keyForm, unresolved } = await toKeyFormSnapshot(uploads(IMAGES.toUpperCase()), { database: db });

		expect(keyForm.fields[0]!.meta.options).toEqual({ folder: 'images' });
		expect(unresolved).toEqual([]);
	});

	it('keeps an ID with no folder and reports it', async () => {
		const { snapshot: keyForm, unresolved } = await toKeyFormSnapshot(uploads(REPLACEMENT), { database: db });

		expect(keyForm.fields[0]!.meta.options).toEqual({ folder: REPLACEMENT });
		expect(unresolved).toEqual([{ field: 'articles.image', path: 'meta.options.folder', value: REPLACEMENT }]);
	});

	it('changes the hash when a folder the schema uses is deleted, moved, or replaced, and not when it is renamed', async () => {
		const before = await hashOf(uploads(IMAGES));

		await db('directus_folders').where('id', IMAGES).update({ name: 'Renamed' });
		expect(await hashOf(uploads(IMAGES))).toBe(before);

		expect(await hashOf(uploads(DOCS))).not.toBe(before);

		await db('directus_folders').where('id', IMAGES).delete();
		expect(await hashOf(uploads(IMAGES))).not.toBe(before);

		await db('directus_folders').insert({ id: REPLACEMENT, key: 'images', name: 'Images' });
		expect(await hashOf(uploads(IMAGES))).not.toBe(before);
		expect(await hashOf(uploads(REPLACEMENT))).toBe(before);
	});
});
