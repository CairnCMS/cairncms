/**
 * Shared constants for the integration-test fixture. Keep all fixed UUIDs,
 * collection names, and seed-data constants here so tests can import without
 * cross-file duplication.
 */

export const COLLECTIONS = {
	categories: 'sdk_test_categories',
	items: 'sdk_test_items',
	publicItems: 'sdk_test_public_items',
} as const;

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'admin';

export const CATEGORY_IDS = {
	electronics: '00000000-0000-4000-8000-000000000001',
	books: '00000000-0000-4000-8000-000000000002',
	garden: '00000000-0000-4000-8000-000000000003',
} as const;

export const ITEM_IDS = {
	laptop: '00000000-0000-4000-8000-000000000101',
	phone: '00000000-0000-4000-8000-000000000102',
	headphones: '00000000-0000-4000-8000-000000000103',
	novel1: '00000000-0000-4000-8000-000000000201',
	novel2: '00000000-0000-4000-8000-000000000202',
	textbook: '00000000-0000-4000-8000-000000000203',
	shovel: '00000000-0000-4000-8000-000000000301',
	seeds: '00000000-0000-4000-8000-000000000302',
	pot: '00000000-0000-4000-8000-000000000303',
	gloves: '00000000-0000-4000-8000-000000000304',
} as const;

export const PUBLIC_ITEM_IDS = {
	welcome: '00000000-0000-4000-8000-000000000501',
	announcement: '00000000-0000-4000-8000-000000000502',
} as const;

/** Environment variables published by globalSetup for tests to consume. */
export const ENV_KEYS = {
	url: 'SDK_IT_URL',
	adminEmail: 'SDK_IT_ADMIN_EMAIL',
	adminPassword: 'SDK_IT_ADMIN_PASSWORD',
	tempDir: 'SDK_IT_TEMP_DIR',
} as const;
