import { expect } from 'vitest';
import { apiTest as test } from '../../fixtures/environment';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('destructive schema changes stay in the file-owned database', async ({ api }) => {
	await api.database.raw('DROP TABLE ?? CASCADE', ['directus_collections']);
	expect(await api.database.schema.hasTable('directus_collections')).toBe(false);
});
