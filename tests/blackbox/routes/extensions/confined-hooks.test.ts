import { getUrl } from '@common/config';
import { CreateCollection } from '@common/functions';
import vendors from '@common/get-dbs-to-test';
import { USER } from '@common/variables';
import request from 'supertest';

const HOOK_COLLECTION = 'confined_hook_records';
const FILTER_HOOK = 'cairncms-extension-confined-filter-hook';
const ACTION_HOOK = 'cairncms-extension-confined-action-hook';

function admin(req: request.Test): request.Test {
	return req.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);
}

async function clearItems(vendor: string) {
	const existing = await admin(
		request(getUrl(vendor))
			.get(`/items/${HOOK_COLLECTION}`)
			.query({ fields: ['id'], limit: -1 })
	);

	const ids = (existing.body.data ?? []).map((row: { id: number }) => row.id);

	if (ids.length > 0) {
		await admin(request(getUrl(vendor)).delete(`/items/${HOOK_COLLECTION}`)).send(ids);
	}
}

describe('Confined event hooks through the real binding', () => {
	beforeAll(async () => {
		for (const vendor of vendors) {
			await CreateCollection(vendor, {
				collection: HOOK_COLLECTION,
				fields: [
					{ field: 'title', type: 'string', meta: {}, schema: {} },
					{ field: 'stamped', type: 'string', meta: {}, schema: {} },
					{ field: 'stamped_by', type: 'string', meta: {}, schema: {} },
					{ field: 'explode', type: 'boolean', meta: {}, schema: {} },
				],
			});

			await clearItems(vendor);
		}
	}, 180000);

	describe('fixture registration', () => {
		it.each(vendors)('%s loads both confined hook fixtures through the real loader', async (vendor) => {
			const response = await admin(request(getUrl(vendor)).get('/extensions')).expect(200);

			const byName = Object.fromEntries(response.body.data.map((entry: { name: string }) => [entry.name, entry]));

			expect(byName[FILTER_HOOK]?.status).toBe('loaded');
			expect(byName[ACTION_HOOK]?.status).toBe('loaded');
		});
	});

	describe('filter transformation', () => {
		it.each(vendors)(
			'%s transforms a created item through a real child while a loaded action hook does not break the create',
			async (vendor) => {
				const title = `alpha-${vendor}`;

				// The action hook fixture is loaded and throws on this same event. The
				// create succeeding proves a confined action hook cannot break the
				// platform action. Observing the action actually fire has no production
				// sink under SSRF, so dispatch is proven at the emitter level instead.
				const created = await admin(request(getUrl(vendor)).post(`/items/${HOOK_COLLECTION}`)).send({ title });

				expect(created.status).toBe(200);

				const stored = await admin(
					request(getUrl(vendor))
						.get(`/items/${HOOK_COLLECTION}/${created.body.data.id}`)
						.query({ fields: ['title', 'stamped', 'stamped_by'] })
				);

				expect(stored.status).toBe(200);
				expect(stored.body.data.title).toBe(title);
				expect(stored.body.data.stamped).toBe('by-confined-hook');

				// The event accountability reached the guest: the stamp carries the caller.
				expect(typeof stored.body.data.stamped_by).toBe('string');
				expect(stored.body.data.stamped_by.length).toBeGreaterThan(0);
			},
			60000
		);

		it.each(vendors)(
			'%s blocks the platform action with a sanitized error when the filter fails',
			async (vendor) => {
				const title = `blocked-${vendor}`;

				const refused = await admin(request(getUrl(vendor)).post(`/items/${HOOK_COLLECTION}`)).send({
					title,
					explode: true,
				});

				expect(refused.status).toBe(500);
				expect(JSON.stringify(refused.body)).not.toContain('refused this payload');

				const persisted = await admin(
					request(getUrl(vendor))
						.get(`/items/${HOOK_COLLECTION}`)
						.query({ filter: { title: { _eq: title } }, fields: ['id'] })
				);

				expect(persisted.body.data).toEqual([]);
			},
			60000
		);
	});
});
