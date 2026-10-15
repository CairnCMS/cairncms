import { randomUUID } from 'crypto';
import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { apiTest as test } from '../../fixtures/environment';
import { CreateCollection, CreateFieldM2A } from '../../fixtures/data';
import request, { setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

type Snapshot = {
	collections: Array<{ collection: string; [key: string]: unknown }>;
	fields: Array<{ collection: string; [key: string]: unknown }>;
	relations: Array<{ collection: string; related_collection: string | null }>;
};

function suffix(): string {
	return randomUUID().replace(/-/g, '').slice(0, 10);
}

async function createFolder(api: Api, collection: string): Promise<void> {
	await setupRequest(api.url)
		.post('/collections')
		.auth(api.adminToken, { type: 'bearer' })
		.send({ collection, meta: {}, schema: null })
		.expect(200);
}

async function clearCache(api: Api): Promise<void> {
	await setupRequest(api.url).post('/utils/cache/clear').auth(api.adminToken, { type: 'bearer' }).expect(200);
}

async function snapshotWithout(api: Api, dropped: string[]): Promise<Snapshot> {
	const response = await setupRequest(api.url).get('/schema/snapshot').auth(api.adminToken, { type: 'bearer' });
	expect(response.statusCode).toBe(200);

	const snapshot = response.body.data as Snapshot;
	const names = snapshot.collections.map((entry) => entry.collection);

	for (const collection of dropped) expect(names).toContain(collection);

	return {
		...snapshot,
		collections: snapshot.collections.filter((entry) => !dropped.includes(entry.collection)),
		fields: snapshot.fields.filter((entry) => !dropped.includes(entry.collection)),
		relations: snapshot.relations.filter(
			(entry) => !dropped.includes(entry.collection) && !dropped.includes(entry.related_collection ?? '')
		),
	};
}

async function diffThenApply(api: Api, desired: Snapshot) {
	const diff = await setupRequest(api.url)
		.post('/schema/diff')
		.auth(api.adminToken, { type: 'bearer' })
		.send(desired)
		.set('Content-type', 'application/json');

	expect(diff.statusCode).toBe(200);

	return request(api.url)
		.post('/schema/apply')
		.auth(api.adminToken, { type: 'bearer' })
		.send(diff.body.data)
		.set('Content-type', 'application/json');
}

async function expectCollectionGone(api: Api, collection: string): Promise<void> {
	expect(await api.database.schema.hasTable(collection)).toBe(false);
	expect(await api.database('directus_collections').where({ collection })).toEqual([]);
	expect(await api.database('directus_fields').where({ collection })).toEqual([]);
	expect(await api.database('directus_permissions').where({ collection })).toEqual([]);
}

async function removeCollections(api: Api, collections: string[]): Promise<void> {
	for (const collection of collections) {
		const meta = await api.database('directus_collections').where({ collection }).first();

		if (meta !== undefined || (await api.database.schema.hasTable(collection))) {
			const response = await request(api.url)
				.delete(`/collections/${collection}`)
				.auth(api.adminToken, { type: 'bearer' });

			expect([204, 403]).toContain(response.statusCode);
		}

		await api.database.schema.dropTableIfExists(collection);
		await api.database('directus_fields').where({ collection }).delete();
		await api.database('directus_permissions').where({ collection }).delete();
		await api.database('directus_collections').where({ collection }).delete();
	}

	await clearCache(api);
}

describe('schema apply deletes every dropped collection', () => {
	test('deletes a collection grouped under a surviving folder, with its permissions', async ({ api }) => {
		const id = suffix();
		const folder = `folder_${id}`;
		const notes = `notes_${id}`;
		let role: string | undefined;

		try {
			await createFolder(api, folder);
			await CreateCollection(api, { collection: notes, meta: { group: folder } });

			const created = await setupRequest(api.url)
				.post('/roles')
				.auth(api.adminToken, { type: 'bearer' })
				.send({ name: `reader_${id}` })
				.expect(200);

			role = created.body.data.id;

			await setupRequest(api.url)
				.post('/permissions')
				.auth(api.adminToken, { type: 'bearer' })
				.send({ role, collection: notes, action: 'read', fields: ['*'] })
				.expect(200);

			const apply = await diffThenApply(api, await snapshotWithout(api, [notes]));

			expect(apply.statusCode).toBe(204);
			await expectCollectionGone(api, notes);
			expect(await api.database('directus_collections').where({ collection: folder })).toHaveLength(1);
		} finally {
			await removeCollections(api, [notes, folder]);

			if (role !== undefined) {
				await setupRequest(api.url).delete(`/roles/${role}`).auth(api.adminToken, { type: 'bearer' }).expect(204);
			}
		}
	});

	test('deletes a table that has no metadata row', async ({ api }) => {
		const imported = `imported_${suffix()}`;

		try {
			await api.database.schema.createTable(imported, (table) => {
				table.increments('id').primary();
				table.string('title');
			});

			await clearCache(api);

			const apply = await diffThenApply(api, await snapshotWithout(api, [imported]));

			expect(apply.statusCode).toBe(204);
			await expectCollectionGone(api, imported);
		} finally {
			await removeCollections(api, [imported]);
		}
	});

	test('deletes a nested chain of dropped collections under a surviving folder', async ({ api }) => {
		const id = suffix();
		const folder = `folder_${id}`;
		const archive = `archive_${id}`;
		const entries = `entries_${id}`;

		try {
			await createFolder(api, folder);
			await CreateCollection(api, { collection: archive, meta: { group: folder } });
			await CreateCollection(api, { collection: entries, meta: { group: archive } });

			const apply = await diffThenApply(api, await snapshotWithout(api, [archive, entries]));

			expect(apply.statusCode).toBe(204);
			await expectCollectionGone(api, archive);
			await expectCollectionGone(api, entries);
			expect(await api.database('directus_collections').where({ collection: folder })).toHaveLength(1);
		} finally {
			await removeCollections(api, [entries, archive, folder]);
		}
	});

	test('removes every dropped grouped collection from retained any-to-any relations', async ({ api }) => {
		const id = suffix();
		const folder = `folder_${id}`;
		const cards = `cards_${id}`;
		const notes = `notes_${id}`;
		const posts = `posts_${id}`;
		const pages = `pages_${id}`;
		const blocks = `pages_blocks_${id}`;
		const extras = `pages_extras_${id}`;

		try {
			await createFolder(api, folder);
			await CreateCollection(api, { collection: cards, meta: { group: folder } });
			await CreateCollection(api, { collection: notes, meta: { group: folder } });
			await CreateCollection(api, { collection: posts });
			await CreateCollection(api, { collection: pages });

			await CreateFieldM2A(api, {
				collection: pages,
				field: 'blocks',
				junctionCollection: blocks,
				relatedCollections: [posts, cards, notes],
			});

			await CreateFieldM2A(api, {
				collection: pages,
				field: 'extras',
				junctionCollection: extras,
				relatedCollections: [cards, notes],
			});

			const apply = await diffThenApply(api, await snapshotWithout(api, [cards, notes]));

			expect(apply.statusCode).toBe(204);
			await expectCollectionGone(api, cards);
			await expectCollectionGone(api, notes);

			const allowed = async (junction: string) =>
				(await api.database('directus_relations').where({ many_collection: junction, many_field: 'item' }).first())
					?.one_allowed_collections;

			expect(await allowed(blocks)).toBe(posts);
			expect(await allowed(extras)).toBe('');
		} finally {
			await removeCollections(api, [blocks, extras, pages, posts, notes, cards, folder]);
		}
	});
});

describe('schema apply refuses removing the table or metadata of a kept collection', () => {
	const cases: Array<[string, (entry: Record<string, unknown>) => void, string]> = [
		['an omitted table', (entry) => delete entry['schema'], "can't remove its table"],
		['omitted metadata', (entry) => delete entry['meta'], "can't remove its collection metadata"],
		['metadata set to null', (entry) => (entry['meta'] = null), "can't remove its collection metadata"],
	];

	for (const [label, edit, message] of cases) {
		test(`refuses ${label} before any write and keeps the collection and its data`, async ({ api }) => {
			const id = suffix();
			const added = `added_${id}`;
			const kept = `kept_${id}`;

			try {
				await CreateCollection(api, { collection: added });

				await CreateCollection(api, {
					collection: kept,
					fields: [{ field: 'title', type: 'string', meta: {}, schema: {} }],
				});

				await api.database(kept).insert({ title: 'seeded' });

				const desired = await snapshotWithout(api, []);
				await removeCollections(api, [added]);

				edit(desired.collections.find((entry) => entry.collection === kept)!);

				const rows = await api.database(kept).select('title');
				const metadata = await api.database('directus_collections').where({ collection: kept });
				const fields = await api.database('directus_fields').where({ collection: kept }).orderBy('id');

				const apply = await diffThenApply(api, desired);

				expect(apply.statusCode).toBe(400);
				expect(apply.body.errors?.[0]?.extensions?.code).toBe('INVALID_PAYLOAD');
				expect(apply.body.errors?.[0]?.message).toContain(message);

				await expectCollectionGone(api, added);
				expect(await api.database(kept).select('title')).toEqual(rows);
				expect(await api.database('directus_collections').where({ collection: kept })).toEqual(metadata);
				expect(await api.database('directus_fields').where({ collection: kept }).orderBy('id')).toEqual(fields);
			} finally {
				await removeCollections(api, [added, kept]);
			}
		});
	}

	test('applies a field added to a table whose null metadata the snapshot omits', async ({ api }) => {
		const unconfigured = `unconfigured_${suffix()}`;

		try {
			await api.database.schema.createTable(unconfigured, (table) => {
				table.increments('id').primary();
				table.string('title');
			});

			await clearCache(api);

			const desired = await snapshotWithout(api, []);
			const entry = desired.collections.find((collection) => collection.collection === unconfigured)!;

			expect(entry['meta']).toBeNull();
			delete entry['meta'];

			const title = desired.fields.find((field) => field.collection === unconfigured && field['field'] === 'title')!;

			desired.fields.push({
				...title,
				field: 'subtitle',
				schema: { ...(title['schema'] as Record<string, unknown>), name: 'subtitle' },
			});

			const apply = await diffThenApply(api, desired);

			expect(apply.statusCode).toBe(204);
			expect(await api.database.schema.hasColumn(unconfigured, 'subtitle')).toBe(true);
		} finally {
			await removeCollections(api, [unconfigured]);
		}
	});
});
