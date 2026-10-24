import { describe, expect } from 'vitest';
import { apiTest as test, type Api } from '../../fixtures/environment';
import { CreateCollection, CreateField } from '../../fixtures/data';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import {
	applyIfChanged,
	removeCollections,
	schemaDiffStatus,
	snapshotWithout,
	suffix,
	type Snapshot,
} from './apply-helpers';

initializeFixtures();

type Entry = Record<string, any>;

function names() {
	const id = suffix();
	return { posts: `posts_${id}`, all: [`posts_${id}`] };
}

async function createScenario(api: Api, posts: string): Promise<void> {
	await CreateCollection(api, { collection: posts });

	await CreateField(api, {
		collection: posts,
		field: 'headline',
		type: 'string',
		meta: { note: 'Headline' },
		schema: { max_length: 500, default_value: 'draft', is_nullable: false },
	});

	await CreateField(api, {
		collection: posts,
		field: 'score',
		type: 'decimal',
		schema: { numeric_precision: 10, numeric_scale: 2 },
	});

	await api.database(posts).insert({ headline: 'kept', score: 1.25 });
}

async function captureState(api: Api, collection: string): Promise<Entry> {
	return {
		columns: await api.database(collection).columnInfo(),
		rows: await api.database(collection).select('*').orderBy('id'),
		fields: await api.database('directus_fields').where({ collection }).orderBy('id'),
	};
}

function fieldEntry(desired: Snapshot, collection: string, field: string): Entry {
	return desired.fields.find((entry) => entry.collection === collection && entry['field'] === field)!;
}

describe('schema apply keeps a column or metadata property the file omits', () => {
	test('previews and applies no change when a field omits a column and a metadata property', async ({ api }) => {
		const { posts, all } = names();

		try {
			await createScenario(api, posts);

			const desired = await snapshotWithout(api, []);
			const headline = fieldEntry(desired, posts, 'headline');
			delete headline['schema']['max_length'];
			delete headline['schema']['default_value'];
			delete headline['meta']['note'];

			const before = await captureState(api, posts);

			expect(await schemaDiffStatus(api, desired)).toBe(204);
			expect(await captureState(api, posts)).toEqual(before);
		} finally {
			await removeCollections(api, all);
		}
	});

	test('preserves omitted column properties through a real column alteration', async ({ api }) => {
		const { posts, all } = names();

		try {
			await createScenario(api, posts);

			const before = await captureState(api, posts);

			const desired = await snapshotWithout(api, []);
			const headline = fieldEntry(desired, posts, 'headline');
			headline['schema']['is_nullable'] = true;
			delete headline['schema']['max_length'];
			delete headline['schema']['default_value'];

			const apply = await applyIfChanged(api, desired);
			expect(apply.statusCode).toBe(204);

			const after = await captureState(api, posts);

			expect(after.columns['headline'].nullable).toBe(true);
			expect(after.columns['headline'].maxLength).toBe(before.columns['headline'].maxLength);
			expect(after.columns['headline'].defaultValue).toBe(before.columns['headline'].defaultValue);
			expect(after.rows).toEqual(before.rows);
		} finally {
			await removeCollections(api, all);
		}
	});

	test('preserves an omitted numeric scale through a real precision change', async ({ api, vendor }) => {
		const { posts, all } = names();

		try {
			await createScenario(api, posts);

			const before = await captureState(api, posts);

			const desired = await snapshotWithout(api, []);
			const score = fieldEntry(desired, posts, 'score');
			score['schema']['numeric_precision'] = 12;
			delete score['schema']['numeric_scale'];

			const apply = await applyIfChanged(api, desired);
			expect(apply.statusCode).toBe(204);

			expect((await captureState(api, posts)).rows).toEqual(before.rows);

			if (vendor !== 'sqlite3') {
				const applied = fieldEntry(await snapshotWithout(api, []), posts, 'score');
				expect(applied['schema']['numeric_precision']).toBe(12);
				expect(applied['schema']['numeric_scale']).toBe(2);
			}
		} finally {
			await removeCollections(api, all);
		}
	});

	test('applies an explicit metadata change while keeping an omitted column property', async ({ api }) => {
		const { posts, all } = names();

		try {
			await createScenario(api, posts);

			const before = await captureState(api, posts);

			const desired = await snapshotWithout(api, []);
			const headline = fieldEntry(desired, posts, 'headline');
			headline['meta']['note'] = 'Lead';
			delete headline['schema']['max_length'];

			const apply = await applyIfChanged(api, desired);
			expect(apply.statusCode).toBe(204);

			const after = await captureState(api, posts);
			expect(after.columns['headline'].maxLength).toBe(before.columns['headline'].maxLength);
			expect(after.fields.find((row: Entry) => row['field'] === 'headline')!['note']).toBe('Lead');
		} finally {
			await removeCollections(api, all);
		}
	});

	test('a partial file reaches the same state as the full snapshot', async ({ api }) => {
		const { posts, all } = names();

		try {
			await createScenario(api, posts);

			const before = await captureState(api, posts);

			const full = await snapshotWithout(api, []);
			const partial = await snapshotWithout(api, []);
			const headline = fieldEntry(partial, posts, 'headline');
			delete headline['schema']['max_length'];
			delete headline['schema']['default_value'];
			delete headline['meta']['note'];

			expect(await schemaDiffStatus(api, partial)).toBe(204);
			expect(await captureState(api, posts)).toEqual(before);

			expect(await schemaDiffStatus(api, full)).toBe(204);
			expect(await captureState(api, posts)).toEqual(before);
		} finally {
			await removeCollections(api, all);
		}
	});
});
