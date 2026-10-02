import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request from '../../fixtures/request';
import type { Test } from 'supertest';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const ECHO_ENDPOINT = 'cairncms-extension-confined-echo-endpoint';
const AUTH_ENDPOINT = 'cairncms-extension-confined-auth-endpoint';
const RECORD_COLLECTION = 'confined_endpoint_records';
const RECORD_TITLE = 'endpoint record';

function admin(req: Test): Test {
	return req.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`);
}

const test = createIdentityTest({ extensions: [ECHO_ENDPOINT, AUTH_ENDPOINT] }).extend<{
	recordState: Prerequisite<void>;
	record: void;
}>({
	recordState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					await admin(setupRequest(api.url).post('/collections'))
						.send({
							collection: RECORD_COLLECTION,
							meta: {},
							schema: {},
							fields: [
								{ field: 'title', type: 'string', meta: {}, schema: {} },
								{
									field: 'id',
									type: 'integer',
									meta: { hidden: true, interface: 'input', readonly: true },
									schema: { is_primary_key: true, has_auto_increment: true },
								},
							],
						})
						.expect(200);

					await admin(setupRequest(api.url).post(`/items/${RECORD_COLLECTION}`))
						.send({ title: RECORD_TITLE })
						.expect(200);

					await ready();
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	record: [
		async ({ api, identities, recordState, task, skip }, use) => {
			void api;
			void identities;
			requirePrerequisite(recordState, 'confined endpoint record', { task, skip });
			await use();
		},
		{ auto: true },
	],
});

describe('Confined JSON endpoints through the real binding', () => {
	describe('fixture registration', () => {
		test('loads both confined endpoint fixtures through the real loader', async ({ api }) => {
			const response = await request(api.url)
				.get('/extensions')
				.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`)
				.expect(200);

			const byName = Object.fromEntries(response.body.data.map((entry: { name: string }) => [entry.name, entry]));

			expect(byName[ECHO_ENDPOINT]?.status).toBe('loaded');
			expect(byName[AUTH_ENDPOINT]?.status).toBe('loaded');
		});
	});

	describe('request handling through a real child', () => {
		test('serves GET and POST with the shaped request and reduced accountability', async ({ api }) => {
			const get = await request(api.url).get(`/${ECHO_ENDPOINT}/ping`).query({ x: '1' });

			expect(get.status).toBe(200);

			// The platform body parser hands every handler an empty object for a
			// body-less request, and the guest sees the same.
			expect(get.body.echoed).toEqual({ method: 'GET', path: '/ping', query: { x: '1' }, body: {} });

			// An anonymous caller reaches the guest as the reduced public identity.
			expect(get.body.accountability).toEqual({ user: null, role: null, admin: false });

			const post = await request(api.url).post(`/${ECHO_ENDPOINT}/charge`).send({ amount: 12 });

			expect(post.status).toBe(200);
			expect(post.body.echoed).toEqual({ method: 'POST', path: '/charge', query: {}, body: { amount: 12 } });
		}, 60000);

		test('answers HEAD without a body', async ({ api }) => {
			const response = await request(api.url).head(`/${ECHO_ENDPOINT}/ping`);

			expect(response.status).toBe(200);
			expect(response.text ?? '').toBe('');
		}, 60000);
	});

	describe('caller authority', () => {
		test('denies an anonymous caller before the child under authenticated access', async ({ api }) => {
			const anonymous = await request(api.url).get(`/${AUTH_ENDPOINT}/`);

			expect(anonymous.status).toBe(401);

			const authenticated = await request(api.url)
				.get(`/${AUTH_ENDPOINT}/`)
				.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`);

			expect(authenticated.status).toBe(200);
			expect(typeof authenticated.body.user).toBe('string');
			expect(authenticated.body.user.length).toBeGreaterThan(0);
		}, 60000);

		test('applies public and admin accountability when reading a user collection', async ({ api }) => {
			const denied = await request(api.url)
				.post(`/${ECHO_ENDPOINT}/items`)
				.send({ collection: RECORD_COLLECTION, query: { fields: ['title'], limit: 1 } });

			expect(denied.status).toBe(200);
			expect(denied.body).toMatchObject({ ok: false, error: { code: 'denied' } });

			const allowed = await admin(
				request(api.url)
					.post(`/${ECHO_ENDPOINT}/items`)
					.send({ collection: RECORD_COLLECTION, query: { fields: ['title'], limit: 1 } })
			);

			expect(allowed.status).toBe(200);
			expect(allowed.body.ok).toBe(true);
			expect(allowed.body.value).toEqual([{ title: RECORD_TITLE }]);
		}, 60000);
	});

	describe('response and request bounds', () => {
		test('refuses a result that carries anything beyond status and body', async ({ api }) => {
			const response = await request(api.url).get(`/${ECHO_ENDPOINT}/contract-violation`);

			expect(response.status).toBe(500);
			expect(response.headers).not.toHaveProperty('x-smuggled');
		}, 60000);

		test('fails an oversized reply closed and keeps serving', async ({ api }) => {
			const oversized = await request(api.url)
				.get(`/${ECHO_ENDPOINT}/big`)
				.query({ bytes: String(2 * 1024 * 1024) });

			expect(oversized.status).toBe(500);

			const followUp = await request(api.url).get(`/${ECHO_ENDPOINT}/ping`);
			expect(followUp.status).toBe(200);
		}, 60000);

		test('refuses an oversized query before the child', async ({ api }) => {
			const query = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v']));

			const response = await request(api.url).get(`/${ECHO_ENDPOINT}/ping`).query(query);

			expect(response.status).toBe(400);
		}, 60000);
	});
});
