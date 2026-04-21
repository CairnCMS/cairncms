import { beforeAll, describe, expect, it } from 'vitest';
import {
	aggregate,
	authentication,
	createDirectus,
	createItem,
	deleteItem,
	readItems,
	rest,
	updateItem,
	type DirectusClient,
	type RestClient,
	type AuthenticationClient,
} from '../../src/index.js';
import { CATEGORY_IDS, COLLECTIONS, ENV_KEYS, ITEM_IDS, PUBLIC_ITEM_IDS } from './helpers/constants.js';

const URL = process.env[ENV_KEYS.url]!;
const EMAIL = process.env[ENV_KEYS.adminEmail]!;
const PASSWORD = process.env[ENV_KEYS.adminPassword]!;

type Category = { id: string; name: string };
type Item = { id: string; name: string; value: number; category: Category | string };
type PublicItem = { id: string; name: string };

type Schema = {
	[COLLECTIONS.categories]: Category[];
	[COLLECTIONS.items]: Item[];
	[COLLECTIONS.publicItems]: PublicItem[];
};

let admin: DirectusClient<Schema> & AuthenticationClient<Schema> & RestClient<Schema>;

beforeAll(async () => {
	admin = createDirectus<Schema>(URL).with(authentication('json')).with(rest());
	await admin.login(EMAIL, PASSWORD);
});

describe('REST read', () => {
	it('reads all seeded items', async () => {
		const items = await admin.request(readItems(COLLECTIONS.items, { limit: -1 }));

		expect(items).toHaveLength(10);
	});

	it('reads a seeded item by known id', async () => {
		const items = await admin.request(
			readItems(COLLECTIONS.items, {
				filter: { id: { _eq: ITEM_IDS.laptop } },
				fields: ['id', 'name', 'value'],
			})
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ id: ITEM_IDS.laptop, name: 'laptop', value: 1200 });
	});
});

describe('REST filter DSL', () => {
	it('filters by scalar value with _gt', async () => {
		const items = await admin.request(
			readItems(COLLECTIONS.items, {
				filter: { value: { _gt: 100 } },
				limit: -1,
			})
		);

		const names = items.map((i) => i.name).sort();
		expect(names).toEqual(['headphones', 'laptop', 'phone', 'textbook'].sort());
	});

	it('filters by nested m2o relation with _and', async () => {
		const items = await admin.request(
			readItems(COLLECTIONS.items, {
				filter: {
					_and: [{ value: { _gt: 10 } }, { category: { name: { _eq: 'garden' } } }],
				},
				limit: -1,
			})
		);

		const names = items.map((i) => i.name).sort();
		expect(names).toEqual(['gloves', 'pot', 'shovel'].sort());
	});
});

describe('REST write round-trip', () => {
	it('creates, updates, and deletes an item', async () => {
		const created = await admin.request(
			createItem(COLLECTIONS.items, {
				name: 'test-widget',
				value: 42,
				category: CATEGORY_IDS.electronics,
			})
		);

		expect(created.name).toBe('test-widget');
		expect(created.id).toBeTypeOf('string');

		const updated = await admin.request(updateItem(COLLECTIONS.items, created.id, { value: 99 }));

		expect(updated.value).toBe(99);

		await admin.request(deleteItem(COLLECTIONS.items, created.id));

		const afterDelete = await admin.request(readItems(COLLECTIONS.items, { filter: { id: { _eq: created.id } } }));

		expect(afterDelete).toHaveLength(0);
	});
});

describe('REST aggregate', () => {
	it('counts items grouped by category', async () => {
		const result = await admin.request(
			aggregate(COLLECTIONS.items, {
				aggregate: { count: '*' },
				groupBy: ['category'],
			})
		);

		// 10 seeded items across 3 categories: electronics (3), books (3), garden (4)
		expect(result).toHaveLength(3);
		const byCategory = new Map(result.map((r: any) => [r.category, Number(r.count)]));
		expect(byCategory.get(CATEGORY_IDS.electronics)).toBe(3);
		expect(byCategory.get(CATEGORY_IDS.books)).toBe(3);
		expect(byCategory.get(CATEGORY_IDS.garden)).toBe(4);
	});
});

describe('REST public-role path', () => {
	it('reads public items without authentication', async () => {
		const anonymous = createDirectus<Schema>(URL).with(rest());

		const items = await anonymous.request(readItems(COLLECTIONS.publicItems, { limit: -1 }));

		expect(items).toHaveLength(2);
		const ids = items.map((i) => i.id).sort();
		expect(ids).toEqual([PUBLIC_ITEM_IDS.welcome, PUBLIC_ITEM_IDS.announcement].sort());
	});

	it('rejects unauthenticated reads on admin-only collections', async () => {
		const anonymous = createDirectus<Schema>(URL).with(rest());

		await expect(anonymous.request(readItems(COLLECTIONS.items, { limit: -1 }))).rejects.toThrow();
	});
});
