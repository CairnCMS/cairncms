import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { apiTest as test } from '../../fixtures/environment';
import { CreateCollection, CreateFieldM2O } from '../../fixtures/data';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import {
	diffThenApply,
	expectCollectionGone,
	removeCollections,
	type Snapshot,
	snapshotWithout,
	suffix,
} from './apply-helpers';

initializeFixtures();

async function snapshotOfKeyedPair(api: Api, keyed: string, refs: string): Promise<Snapshot> {
	await CreateCollection(api, {
		collection: keyed,
		fields: [{ field: 'title', type: 'string', meta: {}, schema: {} }],
	});

	await CreateCollection(api, { collection: refs });
	await CreateFieldM2O(api, { collection: refs, field: 'keyed_ref', otherCollection: keyed });

	const desired = await snapshotWithout(api, []);
	await removeCollections(api, [refs, keyed]);

	return desired;
}

function keyField(snapshot: Snapshot, keyed: string): Record<string, any> {
	const field = snapshot.fields.find((entry) => entry.collection === keyed && entry['field'] === 'id');
	expect(field).toBeDefined();
	return field!;
}

describe('schema apply decides a primary key by the column it writes', () => {
	test('applies a relation to a new collection keyed only by an unflagged auto-increment field', async ({ api }) => {
		const id = suffix();
		const keyed = `keyed_${id}`;
		const refs = `refs_${id}`;

		try {
			const desired = await snapshotOfKeyedPair(api, keyed, refs);
			const key = keyField(desired, keyed);

			expect(key['schema']['has_auto_increment']).toBe(true);
			key['schema']['is_primary_key'] = false;

			const apply = await diffThenApply(api, desired);

			expect(apply.statusCode).toBe(204);
			expect(await api.database.schema.hasTable(keyed)).toBe(true);

			expect(
				await api.database('directus_relations').where({ many_collection: refs, many_field: 'keyed_ref' })
			).toEqual([expect.objectContaining({ one_collection: keyed })]);
		} finally {
			await removeCollections(api, [refs, keyed]);
		}
	});

	test('refuses a relation to a new collection keyed by a flagged unknown-typed field, before any write', async ({
		api,
	}) => {
		const id = suffix();
		const keyed = `keyed_${id}`;
		const refs = `refs_${id}`;

		try {
			const desired = await snapshotOfKeyedPair(api, keyed, refs);
			keyField(desired, keyed)['type'] = 'unknown';

			const apply = await diffThenApply(api, desired);

			expect(apply.statusCode).toBe(400);
			expect(apply.body.errors?.[0]?.extensions?.code).toBe('INVALID_PAYLOAD');
			expect(apply.body.errors?.[0]?.message).toBe(`Collection "${keyed}" doesn't exist`);

			await expectCollectionGone(api, keyed);
			await expectCollectionGone(api, refs);
		} finally {
			await removeCollections(api, [refs, keyed]);
		}
	});
});
