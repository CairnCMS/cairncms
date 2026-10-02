import { expect } from 'vitest';
import { apiTest as test } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('explicit companion APIs share only their owned database and can restart independently', async ({ api }) => {
	const collection = 'multiple_api_records';

	await request(api.url)
		.post('/collections')
		.auth(api.adminToken, { type: 'bearer' })
		.send({
			collection,
			meta: {},
			schema: {},
			fields: [
				{ field: 'id', type: 'integer', schema: { is_primary_key: true, has_auto_increment: true } },
				{ field: 'title', type: 'string', schema: {} },
			],
		})
		.expect(200);

	const companion = await api.start({ CACHE_SCHEMA: 'false' });
	expect(companion.url).not.toBe(api.url);

	const written = await request(companion.url)
		.post(`/items/${collection}`)
		.auth(api.adminToken, { type: 'bearer' })
		.send({ title: 'written through companion' })
		.expect(200);

	const read = await request(api.url)
		.get(`/items/${collection}/${written.body.data.id}`)
		.auth(api.adminToken, { type: 'bearer' })
		.expect(200);

	expect(read.body.data.title).toBe('written through companion');
	await api.stop(companion.child);
	expect(companion.child.exitCode !== null || companion.child.signalCode !== null).toBe(true);
	const restarted = await api.start({ CACHE_SCHEMA: 'false' });

	const persisted = await request(restarted.url)
		.get(`/items/${collection}/${written.body.data.id}`)
		.auth(api.adminToken, { type: 'bearer' })
		.expect(200);

	expect(persisted.body.data).toEqual(read.body.data);
}, 60_000);
