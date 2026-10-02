import { expect, inject } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApiTest } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const test = createApiTest({ absoluteOrigin: true });

test('origin exists before initialization and forwards real redirects and cookies', async ({ api }) => {
	expect(api.url).not.toBe(api.backendUrl);
	expect(api.publicUrl).toBe(api.url);
	expect(await api.database.schema.hasTable('directus_collections')).toBe(true);
	expect(await api.database.schema.hasTable('multiple_api_records')).toBe(false);
	const root = await request(api.url).get('/').expect(302);
	expect(root.headers.location).toBe('./admin');
	const direct = await request(api.backendUrl).get('/').expect(302);
	expect(direct.headers.location).toBe(root.headers.location);

	const session = await request(api.url)
		.post('/auth/login')
		.send({ email: 'bootstrap@example.com', password: 'BootstrapPassword123', mode: 'cookie' })
		.expect(200);

	const cookies = session.headers['set-cookie'];

	expect(
		(Array.isArray(cookies) ? cookies : [cookies]).some((cookie: string) =>
			cookie.startsWith('cairncms_refresh_token=')
		)
	).toBe(true);

	expect(session.body.data.access_token).toEqual(expect.any(String));
});

test('companion APIs retain distinct owned absolute origins', async ({ api }) => {
	const first = await api.start({}, { absoluteOrigin: true });
	const second = await api.start({}, { absoluteOrigin: true });
	const urls = [api.url, first.url, second.url];
	expect(new Set(urls).size).toBe(3);
	expect(first.publicUrl).toBe(first.url);
	expect(second.publicUrl).toBe(second.url);
	for (const url of urls) await request(url).get('/server/ping').expect(200);
	await writeFile(join(inject('integration').directory, 'companion-origins.json'), JSON.stringify(urls));
});
