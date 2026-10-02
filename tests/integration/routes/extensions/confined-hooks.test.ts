import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request from '../../fixtures/request';
import type { Test } from 'supertest';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const HOOK_COLLECTION = 'confined_hook_records';
const FILTER_HOOK = 'cairncms-extension-confined-filter-hook';
const ACTION_HOOK = 'cairncms-extension-confined-action-hook';

function admin(req: Test): Test {
	return req.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`);
}

const test = createIdentityTest({ extensions: [FILTER_HOOK, ACTION_HOOK] }).extend<{
	schemaState: Prerequisite<void>;
	schema: void;
	clean: void;
}>({
	schemaState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					await admin(setupRequest(api.url).post('/collections'))
						.send({
							collection: HOOK_COLLECTION,
							meta: {},
							schema: {},
							fields: [
								...['title', 'stamped', 'stamped_by'].map((field) => ({ field, type: 'string', meta: {}, schema: {} })),
								{ field: 'explode', type: 'boolean', meta: {}, schema: {} },
								{
									field: 'id',
									type: 'integer',
									meta: { hidden: true, interface: 'input', readonly: true },
									schema: { is_primary_key: true, has_auto_increment: true },
								},
							],
						})
						.expect(200);

					await ready();
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	schema: [
		async ({ api, identities, schemaState, task, skip }, use) => {
			void api;
			void identities;
			requirePrerequisite(schemaState, 'confined hook schema', { task, skip });
			await use();
		},
		{ auto: true },
	],
	clean: [
		async ({ api, schema }, use) => {
			void schema;
			await api.database(HOOK_COLLECTION).delete();
			const logOffset = (await api.readLogs()).length;
			await use();

			if (Number((await api.database(HOOK_COLLECTION).count({ count: '*' }).first())?.count ?? 0) > 0) {
				// Action hooks complete asynchronously; the failure log marks child completion.
				// Wait before teardown so cleanup cannot interrupt the action.
				await expect
					.poll(async () => (await api.readLogs()).slice(logOffset), { timeout: 10_000 })
					.toContain(`The confined hook "${ACTION_HOOK}" failed for action "${HOOK_COLLECTION}.items.create"`);
			}
		},
		{ auto: true },
	],
});

describe('Confined event hooks through the real binding', () => {
	describe('fixture registration', () => {
		test('loads both confined hook fixtures through the real loader', async ({ api }) => {
			const response = await admin(request(api.url).get('/extensions')).expect(200);

			const byName = Object.fromEntries(response.body.data.map((entry: { name: string }) => [entry.name, entry]));

			expect(byName[FILTER_HOOK]?.status).toBe('loaded');
			expect(byName[ACTION_HOOK]?.status).toBe('loaded');
		});
	});

	describe('filter transformation', () => {
		test('transforms a created item through a real child while a loaded action hook does not break the create', async ({
			api,
			vendor,
		}) => {
			const title = `alpha-${vendor}`;

			// The action hook fixture is loaded and throws on this same event. The
			// create succeeding proves a confined action hook cannot break the
			// platform action. Observing the action actually fire has no production
			// sink under SSRF; the fixture also waits for its sanitized failure log.
			const created = await admin(request(api.url).post(`/items/${HOOK_COLLECTION}`)).send({ title });

			expect(created.status).toBe(200);

			const stored = await admin(
				request(api.url)
					.get(`/items/${HOOK_COLLECTION}/${created.body.data.id}`)
					.query({ fields: ['title', 'stamped', 'stamped_by'] })
			);

			expect(stored.status).toBe(200);
			expect(stored.body.data.title).toBe(title);
			expect(stored.body.data.stamped).toBe('by-confined-hook');

			// The event accountability reached the guest: the stamp carries the caller.
			expect(typeof stored.body.data.stamped_by).toBe('string');
			expect(stored.body.data.stamped_by.length).toBeGreaterThan(0);
		}, 60000);

		test('blocks the platform action with a sanitized error when the filter fails', async ({ api, vendor }) => {
			const title = `blocked-${vendor}`;

			const refused = await admin(request(api.url).post(`/items/${HOOK_COLLECTION}`)).send({
				title,
				explode: true,
			});

			expect(refused.status).toBe(500);
			expect(JSON.stringify(refused.body)).not.toContain('refused this payload');

			const persisted = await admin(
				request(api.url)
					.get(`/items/${HOOK_COLLECTION}`)
					.query({ filter: { title: { _eq: title } }, fields: ['id'] })
			);

			expect(persisted.body.data).toEqual([]);
		}, 60000);
	});
});
