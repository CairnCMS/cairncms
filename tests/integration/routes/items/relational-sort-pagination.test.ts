import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import request, { CreateItem } from '../../fixtures/request';
import { createScenarioTest } from '../../fixtures/scenario';
import { CreateCollection, CreateFieldO2M } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const AUTHORS = 'test_items_sortpage_authors';
const POSTS = 'test_items_sortpage_posts';
const INTERLEAVED_AUTHORS = 'test_items_sortweave_authors';
const INTERLEAVED_POSTS = 'test_items_sortweave_posts';

async function seedAuthors(
	api: Api,
	authors: string,
	posts: string,
	seed: Array<{ name: string; titles: string[] }>
): Promise<void> {
	await CreateCollection(api, { collection: authors, fields: [{ field: 'name', type: 'string' }] });
	await CreateCollection(api, { collection: posts, fields: [{ field: 'title', type: 'string' }] });
	await CreateFieldO2M(api, { collection: authors, field: 'posts', otherCollection: posts, otherField: 'author' });

	for (const author of seed) {
		const created = await CreateItem(api, { collection: authors, item: { name: author.name } });

		for (const title of author.titles) {
			await CreateItem(api, { collection: posts, item: { title, author: created.id } });
		}
	}
}

const test = createScenarioTest({
	prepare: async (api) => {
		await seedAuthors(api, AUTHORS, POSTS, [
			{ name: 'author-mx', titles: ['m', 'x'] },
			{ name: 'author-c', titles: ['c'] },
			{ name: 'author-a', titles: ['a'] },
			{ name: 'author-z', titles: ['z'] },
		]);

		await seedAuthors(api, INTERLEAVED_AUTHORS, INTERLEAVED_POSTS, [
			{ name: 'author-az', titles: ['a', 'z'] },
			{ name: 'author-m', titles: ['m'] },
			{ name: 'author-n', titles: ['n'] },
		]);
	},
	cleanup: async () => {
		/* The owned database is dropped after the API exits. */
	},
});

async function readAuthorNames(
	api: Api,
	query: Record<string, unknown>,
	collection: string = AUTHORS
): Promise<string[]> {
	const response = await request(api.url)
		.get(`/items/${collection}`)
		.query({ fields: 'name', ...query })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);
	return response.body.data.map((item: { name: string }) => item.name);
}

describe('relational sort pagination', () => {
	test('returns a full first page for an ascending sort', async ({ api }) => {
		expect(await readAuthorNames(api, { sort: 'posts.title', limit: 2, page: 1 })).toEqual(['author-a', 'author-c']);
	});

	test('continues on the second page for an ascending sort', async ({ api }) => {
		expect(await readAuthorNames(api, { sort: 'posts.title', limit: 2, page: 2 })).toEqual(['author-mx', 'author-z']);
	});

	test('returns a full first page for a descending sort', async ({ api }) => {
		expect(await readAuthorNames(api, { sort: '-posts.title', limit: 2, page: 1 })).toEqual(['author-z', 'author-mx']);
	});

	test('continues on the second page for a descending sort', async ({ api }) => {
		expect(await readAuthorNames(api, { sort: '-posts.title', limit: 2, page: 2 })).toEqual(['author-c', 'author-a']);
	});

	test('counts an offset in items', async ({ api }) => {
		expect(await readAuthorNames(api, { sort: '-posts.title', limit: 2, offset: 1 })).toEqual([
			'author-mx',
			'author-c',
		]);
	});

	test('returns every item without a limit', async ({ api }) => {
		expect(await readAuthorNames(api, { sort: 'posts.title', limit: -1 })).toEqual([
			'author-a',
			'author-c',
			'author-mx',
			'author-z',
		]);
	});
});

describe('relational sort pagination with interleaved related values', () => {
	test('keeps an item on one page for an ascending sort', async ({ api }) => {
		const query = { sort: 'posts.title', limit: 2 };

		expect(await readAuthorNames(api, { ...query, page: 1 }, INTERLEAVED_AUTHORS)).toEqual(['author-az', 'author-m']);
		expect(await readAuthorNames(api, { ...query, page: 2 }, INTERLEAVED_AUTHORS)).toEqual(['author-n']);
	});

	test('keeps an item on one page for a descending sort', async ({ api }) => {
		const query = { sort: '-posts.title', limit: 2 };

		expect(await readAuthorNames(api, { ...query, page: 1 }, INTERLEAVED_AUTHORS)).toEqual(['author-az', 'author-n']);
		expect(await readAuthorNames(api, { ...query, page: 2 }, INTERLEAVED_AUTHORS)).toEqual(['author-m']);
	});

	test('lists each item once without a limit', async ({ api }) => {
		expect(await readAuthorNames(api, { sort: 'posts.title', limit: -1 }, INTERLEAVED_AUTHORS)).toEqual([
			'author-az',
			'author-m',
			'author-n',
		]);
	});
});
