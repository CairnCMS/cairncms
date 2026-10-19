import type { DeepPartial } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PortableSnapshot, Snapshot, SnapshotField } from '../types/index.js';
import { getSnapshotDiff } from './get-snapshot-diff.js';
import { getTargetSnapshotDiff } from './get-target-snapshot-diff.js';

const IMAGES = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

function fieldOf(
	meta: DeepPartial<SnapshotField['meta']>,
	name = 'image',
	type: SnapshotField['type'] = 'uuid'
): SnapshotField {
	const draft: DeepPartial<SnapshotField> = { collection: 'articles', field: name, type, schema: null, meta };
	return draft as SnapshotField;
}

function portable(fields: SnapshotField[]): PortableSnapshot {
	return { version: 2, release: '1.0.0', collections: [], fields, relations: [] };
}

function currentOf(fields: SnapshotField[]): Snapshot {
	return { version: 1, directus: '1.0.0', collections: [], fields, relations: [] };
}

function uploads(folder: string, version = 1): Snapshot {
	const field = {
		collection: 'articles',
		field: 'image',
		type: 'uuid',
		schema: null,
		meta: { interface: 'file', options: { folder } },
	} as unknown as SnapshotField;

	const header = version === 2 ? { version, release: '1.0.0' } : { version, directus: '1.0.0' };
	return { ...header, collections: [], fields: [field], relations: [] } as unknown as Snapshot;
}

let database: Knex;

beforeEach(async () => {
	database = knex.default({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });

	await database.schema.createTable('directus_folders', (table) => {
		table.uuid('id').primary();
		table.string('key');
	});

	await database('directus_folders').insert({ id: IMAGES, key: 'images' });
});

afterEach(async () => {
	await database.destroy();
});

describe('getTargetSnapshotDiff on a real SQLite database', () => {
	it('diffs a version 1 snapshot against the supplied state', async () => {
		const diff = await getTargetSnapshotDiff(uploads(OTHER), { current: uploads(IMAGES), database });

		expect(diff).toEqual(getSnapshotDiff(uploads(IMAGES), uploads(OTHER)));
	});

	it('compares a version 2 snapshot by folder key', async () => {
		const diff = await getTargetSnapshotDiff(uploads('images', 2), { current: uploads(IMAGES), database });

		expect(diff).toEqual({ collections: [], fields: [], relations: [] });
	});

	it('refuses an invalid version 2 reference', async () => {
		await expect(getTargetSnapshotDiff(uploads('missing', 2), { current: uploads(IMAGES), database })).rejects.toThrow(
			'Folder reference "missing" could not be resolved. Referenced by: articles.image.meta.options.folder'
		);

		await expect(getTargetSnapshotDiff(uploads(OTHER, 2), { current: uploads(IMAGES), database })).rejects.toThrow(
			'is not a folder key'
		);
	});

	it('refuses an unsupported or quoted version', async () => {
		await expect(getTargetSnapshotDiff(uploads(IMAGES, 3), { current: uploads(IMAGES), database })).rejects.toThrow(
			'"version" must be one of [1, 2]'
		);

		await expect(
			getTargetSnapshotDiff({ ...uploads(IMAGES), version: '1' } as any, { current: uploads(IMAGES), database })
		).rejects.toThrow('"version" must be one of [1, 2]');
	});

	it('diffs a version 2 snapshot against a supplied current state', async () => {
		const diff = await getTargetSnapshotDiff(uploads('images', 2), { current: uploads(OTHER), database });

		expect(diff.fields[0]!.diff[0]).toMatchObject({ kind: 'E', rhs: 'images' });
	});

	it('keeps an omitted interface aligned to its folder key with no change', async () => {
		const desired = portable([fieldOf({ options: { folder: 'images' } })]);

		const diff = await getTargetSnapshotDiff(desired, { current: uploads(IMAGES), database });

		expect(diff).toEqual({ collections: [], fields: [], relations: [] });
	});

	it('refuses leaving the registry while omitting its folder options', async () => {
		const desired = portable([fieldOf({ interface: 'custom-widget' })]);

		await expect(getTargetSnapshotDiff(desired, { current: uploads(IMAGES), database })).rejects.toThrow(
			'Restate "meta.options"'
		);
	});

	it('refuses entering the registry while omitting its folder options', async () => {
		const current = currentOf([fieldOf({ interface: 'custom-widget', options: { folder: IMAGES } })]);
		const desired = portable([fieldOf({ interface: 'file' })]);

		await expect(getTargetSnapshotDiff(desired, { current, database })).rejects.toThrow('Restate "meta.options"');
	});

	it('refuses a repeater whose inherited nested folder reference changes interpretation', async () => {
		const current = currentOf([
			fieldOf(
				{
					interface: 'list',
					options: {
						fields: [{ field: 'body', meta: { interface: 'input-rich-text-md', options: { folder: IMAGES } } }],
					},
				},
				'blocks',
				'json'
			),
		]);

		const desired = portable([fieldOf({ interface: 'file' }, 'blocks', 'json')]);

		await expect(getTargetSnapshotDiff(desired, { current, database })).rejects.toThrow('Restate "meta.options"');
	});
});
