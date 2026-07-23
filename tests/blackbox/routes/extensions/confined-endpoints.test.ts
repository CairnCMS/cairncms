import { getUrl } from '@common/config';
import { CreateCollection, CreateItem } from '@common/functions';
import vendors from '@common/get-dbs-to-test';
import { USER } from '@common/variables';
import request from 'supertest';

const ECHO_ENDPOINT = 'cairncms-extension-confined-echo-endpoint';
const AUTH_ENDPOINT = 'cairncms-extension-confined-auth-endpoint';
const RECORD_COLLECTION = 'confined_endpoint_records';
const RECORD_TITLE = 'endpoint record';

function admin(req: request.Test): request.Test {
	return req.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);
}

describe('Confined JSON endpoints through the real binding', () => {
	beforeAll(async () => {
		for (const vendor of vendors) {
			await CreateCollection(vendor, {
				collection: RECORD_COLLECTION,
				fields: [{ field: 'title', type: 'string', meta: {}, schema: {} }],
			});

			const existing = await admin(
				request(getUrl(vendor)).get(`/items/${RECORD_COLLECTION}`).query({ fields: ['id'], limit: -1 })
			);
			const ids = (existing.body.data ?? []).map((row: { id: number }) => row.id);
			if (ids.length > 0) {
				await admin(request(getUrl(vendor)).delete(`/items/${RECORD_COLLECTION}`)).send(ids);
			}

			await CreateItem(vendor, { collection: RECORD_COLLECTION, item: { title: RECORD_TITLE } });
		}
	}, 60000);

	describe('fixture registration', () => {
		it.each(vendors)('%s loads both confined endpoint fixtures through the real loader', async (vendor) => {
			const response = await request(getUrl(vendor))
				.get('/extensions')
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
				.expect(200);

			const byName = Object.fromEntries(response.body.data.map((entry: { name: string }) => [entry.name, entry]));

			expect(byName[ECHO_ENDPOINT]?.status).toBe('loaded');
			expect(byName[AUTH_ENDPOINT]?.status).toBe('loaded');
		});
	});

	describe('request handling through a real child', () => {
		it.each(vendors)(
			'%s serves GET and POST with the shaped request and reduced accountability',
			async (vendor) => {
				const get = await request(getUrl(vendor)).get(`/${ECHO_ENDPOINT}/ping`).query({ x: '1' });

				expect(get.status).toBe(200);

				// The platform body parser hands every handler an empty object for a
				// body-less request, and the guest sees the same.
				expect(get.body.echoed).toEqual({ method: 'GET', path: '/ping', query: { x: '1' }, body: {} });

				// An anonymous caller reaches the guest as the reduced public identity.
				expect(get.body.accountability).toEqual({ user: null, role: null, admin: false });

				const post = await request(getUrl(vendor)).post(`/${ECHO_ENDPOINT}/charge`).send({ amount: 12 });

				expect(post.status).toBe(200);
				expect(post.body.echoed).toEqual({ method: 'POST', path: '/charge', query: {}, body: { amount: 12 } });
			},
			60000
		);

		it.each(vendors)(
			'%s answers HEAD without a body',
			async (vendor) => {
				const response = await request(getUrl(vendor)).head(`/${ECHO_ENDPOINT}/ping`);

				expect(response.status).toBe(200);
				expect(response.text ?? '').toBe('');
			},
			60000
		);
	});

	describe('caller authority', () => {
		it.each(vendors)(
			'%s denies an anonymous caller before the child under authenticated access',
			async (vendor) => {
				const anonymous = await request(getUrl(vendor)).get(`/${AUTH_ENDPOINT}/`);

				expect(anonymous.status).toBe(401);

				const authenticated = await request(getUrl(vendor))
					.get(`/${AUTH_ENDPOINT}/`)
					.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);

				expect(authenticated.status).toBe(200);
				expect(typeof authenticated.body.user).toBe('string');
				expect(authenticated.body.user.length).toBeGreaterThan(0);
			},
			60000
		);

		it.each(vendors)(
			'%s applies public and admin accountability when reading a user collection',
			async (vendor) => {
				const denied = await request(getUrl(vendor))
					.post(`/${ECHO_ENDPOINT}/items`)
					.send({ collection: RECORD_COLLECTION, query: { fields: ['title'], limit: 1 } });

				expect(denied.status).toBe(200);
				expect(denied.body).toMatchObject({ ok: false, error: { code: 'denied' } });

				const allowed = await admin(
					request(getUrl(vendor))
						.post(`/${ECHO_ENDPOINT}/items`)
						.send({ collection: RECORD_COLLECTION, query: { fields: ['title'], limit: 1 } })
				);

				expect(allowed.status).toBe(200);
				expect(allowed.body.ok).toBe(true);
				expect(allowed.body.value).toEqual([{ title: RECORD_TITLE }]);
			},
			60000
		);
	});

	describe('response and request bounds', () => {
		it.each(vendors)(
			'%s refuses a result that carries anything beyond status and body',
			async (vendor) => {
				const response = await request(getUrl(vendor)).get(`/${ECHO_ENDPOINT}/contract-violation`);

				expect(response.status).toBe(500);
				expect(response.headers).not.toHaveProperty('x-smuggled');
			},
			60000
		);

		it.each(vendors)(
			'%s fails an oversized reply closed and keeps serving',
			async (vendor) => {
				const oversized = await request(getUrl(vendor))
					.get(`/${ECHO_ENDPOINT}/big`)
					.query({ bytes: String(2 * 1024 * 1024) });

				expect(oversized.status).toBe(500);

				const followUp = await request(getUrl(vendor)).get(`/${ECHO_ENDPOINT}/ping`);
				expect(followUp.status).toBe(200);
			},
			60000
		);

		it.each(vendors)(
			'%s refuses an oversized query before the child',
			async (vendor) => {
				const query = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v']));

				const response = await request(getUrl(vendor)).get(`/${ECHO_ENDPOINT}/ping`).query(query);

				expect(response.status).toBe(400);
			},
			60000
		);
	});
});
