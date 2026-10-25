import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { apiTest as test } from '../../fixtures/environment';
import { CreateCollection } from '../../fixtures/data';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import {
	clearCache,
	createFolder,
	diffThenApply,
	expectCollectionGone,
	removeCollections,
	type Snapshot,
	snapshotWithout,
	suffix,
} from './apply-helpers';

initializeFixtures();

function entryOf(snapshot: Snapshot, collection: string): Record<string, unknown> {
	const entry = snapshot.collections.find((candidate) => candidate.collection === collection);
	expect(entry).toBeDefined();
	return entry!;
}

async function storedGroup(api: Api, collection: string): Promise<unknown> {
	return (await api.database('directus_collections').where({ collection }).first())?.group;
}

describe('schema apply creates every added collection', () => {
	test('creates a collection grouped under an existing collection with metadata', async ({ api }) => {
		const id = suffix();
		const folder = `folder_${id}`;
		const child = `child_${id}`;

		try {
			await createFolder(api, folder);
			await CreateCollection(api, { collection: child, meta: { group: folder } });

			const desired = await snapshotWithout(api, []);
			await removeCollections(api, [child]);

			const apply = await diffThenApply(api, desired);

			expect(apply.statusCode).toBe(204);
			expect(await api.database.schema.hasTable(child)).toBe(true);
			expect(await storedGroup(api, child)).toBe(folder);
		} finally {
			await removeCollections(api, [child, folder]);
		}
	});

	test('creates a new parent and a collection grouped under it in one diff', async ({ api }) => {
		const id = suffix();
		const parent = `parent_${id}`;
		const child = `child_${id}`;

		try {
			await CreateCollection(api, { collection: parent });
			await CreateCollection(api, { collection: child, meta: { group: parent } });

			const desired = await snapshotWithout(api, []);
			await removeCollections(api, [child, parent]);

			const apply = await diffThenApply(api, desired);

			expect(apply.statusCode).toBe(204);
			expect(await api.database.schema.hasTable(parent)).toBe(true);
			expect(await api.database.schema.hasTable(child)).toBe(true);
			expect(await storedGroup(api, child)).toBe(parent);
		} finally {
			await removeCollections(api, [child, parent]);
		}
	});
});

describe('schema apply refuses a new collection whose group has no metadata, before any write', () => {
	async function expectRefusedWithoutWrites(
		api: Api,
		desired: Snapshot,
		child: string,
		group: string,
		absent: string[]
	) {
		const apply = await diffThenApply(api, desired);

		expect(apply.statusCode).toBe(400);
		expect(apply.body.errors?.[0]?.extensions?.code).toBe('INVALID_PAYLOAD');

		expect(apply.body.errors?.[0]?.message).toBe(
			`Collection "${child}" can't be grouped under "${group}", which has no collection metadata.`
		);

		for (const collection of absent) await expectCollectionGone(api, collection);
	}

	test('refuses a group that does not exist', async ({ api }) => {
		const id = suffix();
		const added = `added_${id}`;
		const folder = `folder_${id}`;
		const child = `child_${id}`;

		try {
			await CreateCollection(api, { collection: added });
			await createFolder(api, folder);
			await CreateCollection(api, { collection: child, meta: { group: folder } });

			const snapshot = await snapshotWithout(api, []);
			await removeCollections(api, [added, child, folder]);

			const desired = { ...snapshot, collections: snapshot.collections.filter((entry) => entry.collection !== folder) };

			await expectRefusedWithoutWrites(api, desired, child, folder, [added, child, folder]);
		} finally {
			await removeCollections(api, [added, child, folder]);
		}
	});

	test('refuses a group that is a table without metadata', async ({ api }) => {
		const id = suffix();
		const added = `added_${id}`;
		const child = `child_${id}`;
		const raw = `raw_${id}`;

		try {
			await api.database.schema.createTable(raw, (table) => {
				table.increments('id').primary();
			});

			await clearCache(api);
			await CreateCollection(api, { collection: added });
			await CreateCollection(api, { collection: child });

			const desired = await snapshotWithout(api, []);
			await removeCollections(api, [added, child]);

			(entryOf(desired, child)['meta'] as Record<string, unknown>)['group'] = raw;

			await expectRefusedWithoutWrites(api, desired, child, raw, [added, child]);
			expect(await api.database.schema.hasTable(raw)).toBe(true);
		} finally {
			await removeCollections(api, [added, child, raw]);
		}
	});

	test('refuses a group that the diff creates without metadata', async ({ api }) => {
		const id = suffix();
		const added = `added_${id}`;
		const parent = `parent_${id}`;
		const child = `child_${id}`;

		try {
			await CreateCollection(api, { collection: added });
			await CreateCollection(api, { collection: parent });
			await CreateCollection(api, { collection: child, meta: { group: parent } });

			const desired = await snapshotWithout(api, []);
			await removeCollections(api, [added, child, parent]);

			entryOf(desired, parent)['meta'] = null;

			await expectRefusedWithoutWrites(api, desired, child, parent, [added, parent, child]);
		} finally {
			await removeCollections(api, [added, child, parent]);
		}
	});
});
