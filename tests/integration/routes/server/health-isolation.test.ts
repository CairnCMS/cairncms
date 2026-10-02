import { expect } from 'vitest';
import { apiTest as test } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

test('starts a healthy API with isolated collection state', async ({ api }) => {
	const response = await request(api.url).get('/server/health').auth(api.adminToken, { type: 'bearer' }).expect(200);
	expect(response.body.status).toBe('ok');
	expect(await api.database.schema.hasTable('test_items_no_relations_artists_integer')).toBe(false);
});
