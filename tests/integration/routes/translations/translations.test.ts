import { describe, expect } from 'vitest';
import { identityTest as test } from '../../fixtures/identities';
import type { Api } from '../../fixtures/environment';

import * as common from '../../fixtures/identities';

import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const adminToken = common.USER.ADMIN.TOKEN;
const appToken = common.USER.APP_ACCESS.TOKEN;

const CASE_INSENSITIVE = ['mysql', 'mysql5', 'maria'];
const CASE_SENSITIVE = ['postgres', 'postgres10', 'sqlite3'];

async function cleanup(api: Api, keys: string[]) {
	const url = api.url;

	const existing = await request(url)
		.get('/translations')
		.query({ filter: { key: { _in: keys } }, fields: 'id', limit: -1 })
		.set('Authorization', `Bearer ${adminToken}`);

	expect(existing.status).toBe(200);

	const ids = (existing.body.data ?? []).map((row: { id: string }) => row.id);

	if (ids.length > 0) {
		const deleted = await request(url).delete('/translations').set('Authorization', `Bearer ${adminToken}`).send(ids);
		expect(deleted.status).toBe(204);
	}
}

describe('/translations', () => {
	describe('Permissions', () => {
		describe('Unauthenticated', () => {
			test('denies read', async ({ api }) => {
				const response = await request(api.url).get('/translations');

				expect([401, 403]).toContain(response.status);
			});
		});

		describe('App access role', () => {
			test('allows read', async ({ api }) => {
				const response = await request(api.url).get('/translations').set('Authorization', `Bearer ${appToken}`);

				expect(response.status).toBe(200);
			});

			test('denies create', async ({ api }) => {
				const response = await request(api.url)
					.post('/translations')
					.set('Authorization', `Bearer ${appToken}`)
					.send({ key: 'translations_test_app_denied', language: 'en-US', value: 'denied' });

				expect(response.status).toBe(403);
			});
		});
	});

	describe('Admin CRUD', () => {
		test('creates, reads, updates identity, and deletes', async ({ api }) => {
			const url = api.url;

			try {
				const created = await request(url)
					.post('/translations')
					.set('Authorization', `Bearer ${adminToken}`)
					.send({ key: 'translations_test_crud', language: 'en-US', value: 'hello' });

				expect(created.status).toBe(200);
				const id = created.body.data.id;

				const read = await request(url).get(`/translations/${id}`).set('Authorization', `Bearer ${adminToken}`);
				expect(read.status).toBe(200);
				expect(read.body.data.value).toBe('hello');

				const updated = await request(url)
					.patch(`/translations/${id}`)
					.set('Authorization', `Bearer ${adminToken}`)
					.send({ key: 'translations_test_crud_renamed', language: 'fr-FR', value: 'bonjour' });

				expect(updated.status).toBe(200);
				expect(updated.body.data.key).toBe('translations_test_crud_renamed');
				expect(updated.body.data.language).toBe('fr-FR');

				const deleted = await request(url).delete(`/translations/${id}`).set('Authorization', `Bearer ${adminToken}`);
				expect(deleted.status).toBe(204);
			} finally {
				await cleanup(api, ['translations_test_crud', 'translations_test_crud_renamed']);
			}
		});
	});

	describe('Uniqueness', () => {
		test('rejects a byte-identical duplicate batch', async ({ api }) => {
			const url = api.url;

			try {
				const response = await request(url)
					.post('/translations')
					.set('Authorization', `Bearer ${adminToken}`)
					.send([
						{ key: 'translations_test_dup', language: 'en-US', value: 'a' },
						{ key: 'translations_test_dup', language: 'en-US', value: 'b' },
					]);

				expect(response.status).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('RECORD_NOT_UNIQUE');

				const check = await request(url)
					.get('/translations')
					.query({ filter: { key: { _eq: 'translations_test_dup' } } })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(check.body.data).toHaveLength(0);
			} finally {
				await cleanup(api, ['translations_test_dup']);
			}
		});

		test('applies the native collation to a case-variant batch', async ({ api, vendor }) => {
			expect([...CASE_INSENSITIVE, ...CASE_SENSITIVE]).toContain(vendor);
			const url = api.url;
			const upper = 'TransCaseTest';
			const lower = 'transcasetest';

			try {
				const response = await request(url)
					.post('/translations')
					.set('Authorization', `Bearer ${adminToken}`)
					.send([
						{ key: upper, language: 'en-US', value: 'upper' },
						{ key: lower, language: 'en-US', value: 'lower' },
					]);

				if (CASE_INSENSITIVE.includes(vendor)) {
					expect(response.status).toBe(400);
					expect(response.body.errors[0].extensions.code).toBe('RECORD_NOT_UNIQUE');
				} else {
					expect(response.status).toBe(200);
					expect(response.body.data).toHaveLength(2);
				}
			} finally {
				await cleanup(api, [upper, lower]);
			}
		});
	});
});
