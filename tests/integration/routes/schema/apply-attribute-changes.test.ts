import { describe, expect } from 'vitest';
import { apiTest as test, type Api } from '../../fixtures/environment';
import { CreateCollection, CreateField, CreateFieldM2O } from '../../fixtures/data';
import { setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import {
	clearCache,
	diffThenApply,
	expectCollectionGone,
	removeCollections,
	snapshotWithout,
	suffix,
	type Snapshot,
} from './apply-helpers';

initializeFixtures();

type Entry = Record<string, any>;

type Scenario = {
	added: string;
	articles: string;
	authors: string;
	editors: string;
	all: string[];
};

function scenarioNames(): Scenario {
	const id = suffix();
	const articles = `articles_${id}`;
	const added = `added_${id}`;
	const authors = `authors_${id}`;
	const editors = `editors_${id}`;

	return { added, articles, authors, editors, all: [articles, added, authors, editors] };
}

async function createScenario(api: Api, scenario: Scenario): Promise<void> {
	await CreateCollection(api, { collection: scenario.added });
	await CreateCollection(api, { collection: scenario.authors });
	await CreateCollection(api, { collection: scenario.editors });
	await CreateCollection(api, { collection: scenario.articles });

	await CreateField(api, {
		collection: scenario.articles,
		field: 'title',
		type: 'string',
		meta: { note: 'Headline' },
		schema: { max_length: 1000, default_value: 'Untitled' },
	});

	await CreateField(api, { collection: scenario.articles, field: 'position', type: 'integer' });
	await CreateField(api, { collection: scenario.articles, field: 'rank', type: 'integer' });

	await CreateFieldM2O(api, {
		collection: scenario.articles,
		field: 'author',
		otherCollection: scenario.authors,
		relationMeta: { sort_field: 'position' },
	});

	await api.database(scenario.articles).insert({ title: 'kept' });
}

async function relationsOf(api: Api, collection: string, field: string): Promise<Entry[]> {
	const response = await setupRequest(api.url)
		.get(`/relations/${collection}`)
		.auth(api.adminToken, { type: 'bearer' })
		.expect(200);

	return (response.body.data as Entry[]).filter((relation) => relation['field'] === field);
}

async function captureState(api: Api, collection: string): Promise<Entry> {
	return {
		columns: await api.database(collection).columnInfo(),
		rows: await api.database(collection).select('*').orderBy('id'),
		fields: await api.database('directus_fields').where({ collection }).orderBy('id'),
		relations: await api.database('directus_relations').where({ many_collection: collection }).orderBy('id'),
		foreignKeys: await relationsOf(api, collection, 'author'),
	};
}

async function desiredWithAdded(api: Api, scenario: Scenario): Promise<Snapshot> {
	const desired = await snapshotWithout(api, []);
	await removeCollections(api, [scenario.added]);
	return desired;
}

function fieldEntry(desired: Snapshot, collection: string, field: string): Entry {
	return desired.fields.find((entry) => entry.collection === collection && entry['field'] === field)!;
}

function relationEntry(desired: Snapshot, collection: string, field: string): Entry {
	return desired.relations.find((entry) => entry.collection === collection && (entry as Entry)['field'] === field)!;
}

describe('schema apply refuses an attribute change it cannot perform on a kept field or relation', () => {
	const cases: Array<[string, (desired: Snapshot, scenario: Scenario) => void, string]> = [
		[
			'an omitted field schema',
			(desired, { articles }) => delete fieldEntry(desired, articles, 'title')['schema'],
			`Field "{articles}.title" can't remove its column and remain as a field.`,
		],
		[
			'a null field schema',
			(desired, { articles }) => (fieldEntry(desired, articles, 'title')['schema'] = null),
			`Field "{articles}.title" can't remove its column and remain as a field.`,
		],
		[
			'omitted field metadata',
			(desired, { articles }) => delete fieldEntry(desired, articles, 'title')['meta'],
			`Field "{articles}.title" can't remove its field metadata.`,
		],
		[
			'an omitted field type',
			(desired, { articles }) => delete fieldEntry(desired, articles, 'title')['type'],
			`Field "{articles}.title" can't remove its type.`,
		],
		[
			'an omitted schema.max_length',
			(desired, { articles }) => delete fieldEntry(desired, articles, 'title')['schema']['max_length'],
			`Field "{articles}.title" can't omit "schema.max_length" from its column definition.`,
		],
		[
			'an omitted schema.default_value',
			(desired, { articles }) => delete fieldEntry(desired, articles, 'title')['schema']['default_value'],
			`Field "{articles}.title" can't omit "schema.default_value" from its column definition.`,
		],
		[
			'omitted relation metadata',
			(desired, { articles }) => delete relationEntry(desired, articles, 'author')['meta'],
			`Relation "{articles}.author" can't remove its relation metadata.`,
		],
		[
			'an omitted relation schema',
			(desired, { articles }) => delete relationEntry(desired, articles, 'author')['schema'],
			`Relation "{articles}.author" can't remove its foreign key and remain as a relation.`,
		],
		[
			'a related_collection retarget',
			(desired, { articles, editors }) => (relationEntry(desired, articles, 'author')['related_collection'] = editors),
			`Relation "{articles}.author" can't change its related collection.`,
		],
		[
			'a meta.one_collection retarget',
			(desired, { articles, editors }) =>
				(relationEntry(desired, articles, 'author')['meta']['one_collection'] = editors),
			`Relation "{articles}.author" can't change its related collection.`,
		],
		[
			'a schema.foreign_key_table retarget',
			(desired, { articles, editors }) =>
				(relationEntry(desired, articles, 'author')['schema']['foreign_key_table'] = editors),
			`Relation "{articles}.author" can't change its related collection.`,
		],
	];

	for (const [label, edit, message] of cases) {
		test(`refuses ${label} before any write and keeps the target unchanged`, async ({ api }) => {
			const scenario = scenarioNames();

			try {
				await createScenario(api, scenario);
				const desired = await desiredWithAdded(api, scenario);
				edit(desired, scenario);

				const before = await captureState(api, scenario.articles);

				expect(before.foreignKeys).toEqual([expect.objectContaining({ related_collection: scenario.authors })]);

				const apply = await diffThenApply(api, desired);

				expect(apply.statusCode).toBe(400);
				expect(apply.body.errors?.[0]?.extensions?.code).toBe('INVALID_PAYLOAD');
				expect(apply.body.errors?.[0]?.message).toBe(message.replace('{articles}', scenario.articles));

				await expectCollectionGone(api, scenario.added);
				expect(await captureState(api, scenario.articles)).toEqual(before);
			} finally {
				await removeCollections(api, scenario.all);
			}
		});
	}
});

describe('schema apply keeps a field or relation whose diff only removes part of it', () => {
	test('keeps a column without a metadata row whose null meta the snapshot omits', async ({ api }) => {
		const scenario = scenarioNames();

		try {
			await createScenario(api, scenario);

			await api.database.schema.alterTable(scenario.articles, (table) => {
				table.integer('legacy');
			});

			await api.database(scenario.articles).update({ legacy: 7 });
			await clearCache(api);

			const desired = await snapshotWithout(api, []);
			const legacy = fieldEntry(desired, scenario.articles, 'legacy');

			expect(legacy['meta']).toBeNull();
			delete legacy['meta'];

			const before = await captureState(api, scenario.articles);
			const apply = await diffThenApply(api, desired);

			expect(apply.statusCode).toBe(204);
			expect(await captureState(api, scenario.articles)).toEqual(before);
			expect(await api.database(scenario.articles).select('legacy')).toEqual([{ legacy: 7 }]);
		} finally {
			await removeCollections(api, scenario.all);
		}
	});

	test('keeps a relation whose snapshot omits meta.sort_field', async ({ api }) => {
		const scenario = scenarioNames();

		try {
			await createScenario(api, scenario);

			const desired = await snapshotWithout(api, []);
			delete relationEntry(desired, scenario.articles, 'author')['meta']['sort_field'];

			const apply = await diffThenApply(api, desired);

			expect(apply.statusCode).toBe(204);

			expect(
				await api.database('directus_relations').where({ many_collection: scenario.articles, many_field: 'author' })
			).toEqual([expect.objectContaining({ one_collection: scenario.authors, sort_field: 'position' })]);

			expect(await relationsOf(api, scenario.articles, 'author')).toEqual([
				expect.objectContaining({
					related_collection: scenario.authors,
					schema: expect.objectContaining({ foreign_key_table: scenario.authors }),
				}),
			]);
		} finally {
			await removeCollections(api, scenario.all);
		}
	});

	test('keeps a field note the snapshot omits', async ({ api }) => {
		const scenario = scenarioNames();

		try {
			await createScenario(api, scenario);

			const desired = await snapshotWithout(api, []);
			delete fieldEntry(desired, scenario.articles, 'title')['meta']['note'];

			const apply = await diffThenApply(api, desired);

			expect(apply.statusCode).toBe(204);

			expect(await api.database('directus_fields').where({ collection: scenario.articles, field: 'title' })).toEqual([
				expect.objectContaining({ note: 'Headline' }),
			]);
		} finally {
			await removeCollections(api, scenario.all);
		}
	});

	test('applies a changed sort field and delete action on a kept relation without moving it', async ({ api }) => {
		const scenario = scenarioNames();

		try {
			await createScenario(api, scenario);

			const desired = await snapshotWithout(api, []);
			const author = relationEntry(desired, scenario.articles, 'author');
			author['meta']['sort_field'] = 'rank';
			author['schema']['on_delete'] = 'CASCADE';

			const apply = await diffThenApply(api, desired);

			expect(apply.statusCode).toBe(204);

			expect(
				await api.database('directus_relations').where({ many_collection: scenario.articles, many_field: 'author' })
			).toEqual([expect.objectContaining({ one_collection: scenario.authors, sort_field: 'rank' })]);

			expect(await relationsOf(api, scenario.articles, 'author')).toEqual([
				expect.objectContaining({
					related_collection: scenario.authors,
					schema: expect.objectContaining({ foreign_key_table: scenario.authors, on_delete: 'CASCADE' }),
				}),
			]);
		} finally {
			await removeCollections(api, scenario.all);
		}
	});
});
