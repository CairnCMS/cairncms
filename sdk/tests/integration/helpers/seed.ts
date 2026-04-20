import { knex, type Knex } from 'knex';
import { CATEGORY_IDS, COLLECTIONS, ITEM_IDS, PUBLIC_ITEM_IDS } from './constants.js';

/**
 * Seed fixture rows directly into the SQLite DB via knex.
 * Bypasses the API entirely — fixture data must not depend on the thing under
 * test. Runs once in globalSetup after the schema fixture has been applied.
 */
export async function seedFixtureData(dbPath: string): Promise<void> {
	const db: Knex = knex({
		client: 'sqlite3',
		connection: { filename: dbPath },
		useNullAsDefault: true,
	});

	try {
		await db(COLLECTIONS.categories).insert([
			{ id: CATEGORY_IDS.electronics, name: 'electronics' },
			{ id: CATEGORY_IDS.books, name: 'books' },
			{ id: CATEGORY_IDS.garden, name: 'garden' },
		]);

		await db(COLLECTIONS.items).insert([
			{ id: ITEM_IDS.laptop, name: 'laptop', value: 1200, category: CATEGORY_IDS.electronics },
			{ id: ITEM_IDS.phone, name: 'phone', value: 800, category: CATEGORY_IDS.electronics },
			{ id: ITEM_IDS.headphones, name: 'headphones', value: 150, category: CATEGORY_IDS.electronics },
			{ id: ITEM_IDS.novel1, name: 'novel-one', value: 20, category: CATEGORY_IDS.books },
			{ id: ITEM_IDS.novel2, name: 'novel-two', value: 25, category: CATEGORY_IDS.books },
			{ id: ITEM_IDS.textbook, name: 'textbook', value: 120, category: CATEGORY_IDS.books },
			{ id: ITEM_IDS.shovel, name: 'shovel', value: 35, category: CATEGORY_IDS.garden },
			{ id: ITEM_IDS.seeds, name: 'seeds', value: 5, category: CATEGORY_IDS.garden },
			{ id: ITEM_IDS.pot, name: 'pot', value: 15, category: CATEGORY_IDS.garden },
			{ id: ITEM_IDS.gloves, name: 'gloves', value: 12, category: CATEGORY_IDS.garden },
		]);

		await db(COLLECTIONS.publicItems).insert([
			{ id: PUBLIC_ITEM_IDS.welcome, name: 'welcome message' },
			{ id: PUBLIC_ITEM_IDS.announcement, name: 'latest announcement' },
		]);
	} finally {
		await db.destroy();
	}
}
