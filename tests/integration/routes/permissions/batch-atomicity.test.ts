import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateRole, CreateCollection, CreateFieldM2O } from '../../fixtures/schema';
import request, { CreateItem } from '../../fixtures/request';
import type { Api } from '../../fixtures/environment';
import { randomUUID } from 'node:crypto';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

async function CreateUser(api: Api, options: { token: string; email: string; role: string }) {
	const response = await setupRequest(api.url)
		.post('/users')
		.auth(api.adminToken, { type: 'bearer' })
		.send(options)
		.expect(200);

	return response.body.data;
}

const adminToken = USER.ADMIN!.TOKEN;

const run = randomUUID().slice(0, 8);
const collection = `test_batch_atomicity_${run}`;
const alphaRoleName = `batch_atomicity_alpha_${run}`;
const betaRoleName = `batch_atomicity_beta_${run}`;
const alphaToken = `BatchAtomicityAlpha${run}`;
const betaToken = `BatchAtomicityBeta${run}`;

type CleanupResult = { ok: true } | { ok: false; reason: string };

async function deleteResource(api: Api, resource: string): Promise<CleanupResult> {
	try {
		if (!api.available()) return { ok: false, reason: 'API unavailable during permission-fixture cleanup' };
		const response = await request(api.url).delete(resource).set('Authorization', `Bearer ${api.adminToken}`);

		if (response.statusCode >= 400 && response.statusCode !== 404) {
			return { ok: false, reason: `DELETE ${resource} on ${api.url} returned ${response.statusCode}` };
		}

		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `DELETE ${resource} on ${api.url} threw ${String(error)}` };
	}
}

type Scenario = { ownedFirst: number; ownedSecond: number; foreign: number };

const test = createIdentityTest().extend<{ scenarioState: Prerequisite<Scenario>; scenario: Scenario }>({
	scenarioState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<Scenario>(
				async (ready) => {
					const cleanups: Array<{ run: () => Promise<CleanupResult> }> = [];

					try {
						const url = api.url;

						const asAdminPost = (path: string, payload: Record<string, unknown>) =>
							setupRequest(url).post(path).set('Authorization', `Bearer ${adminToken}`).send(payload);

						const createRole = async (name: string) => {
							const role = await CreateRole(api, {
								name,
								appAccessEnabled: false,
								adminAccessEnabled: false,
							});

							cleanups.push({ run: () => deleteResource(api, `/roles/${role?.id}`) });
							expect(role.id).toBeDefined();
							return role;
						};

						const createUser = async (token: string, email: string, roleId: string) => {
							const user = await CreateUser(api, { token, email, role: roleId });
							cleanups.push({ run: () => deleteResource(api, `/users/${user?.id}`) });
							expect(user.id).toBeDefined();
							return user;
						};

						const tenant = await CreateCollection(api, {
							collection,
							fields: [{ field: 'title', type: 'string' }],
						});

						cleanups.push({ run: () => deleteResource(api, `/collections/${collection}`) });
						expect(tenant.collection).toBe(collection);

						const owner = await CreateFieldM2O(api, {
							collection,
							field: 'owner',
							otherCollection: 'directus_users',
							primaryKeyType: 'uuid',
						});

						expect(owner.field.field).toBe('owner');
						expect(owner.relation.related_collection).toBe('directus_users');

						const alphaRole = await createRole(alphaRoleName);
						const betaRole = await createRole(betaRoleName);
						const alphaUser = await createUser(alphaToken, `batch-atomicity-alpha-${run}@example.com`, alphaRole.id);
						const betaUser = await createUser(betaToken, `batch-atomicity-beta-${run}@example.com`, betaRole.id);

						const first = await CreateItem(api, {
							collection,
							item: { title: 'alpha-1', owner: alphaUser.id },
						});

						const second = await CreateItem(api, {
							collection,
							item: { title: 'alpha-2', owner: alphaUser.id },
						});

						const other = await CreateItem(api, {
							collection,
							item: { title: 'beta-1', owner: betaUser.id },
						});

						expect(first.id).toBeDefined();
						expect(second.id).toBeDefined();
						expect(other.id).toBeDefined();
						const ownedFirst = first.id;
						const ownedSecond = second.id;
						const foreign = other.id;

						const ownFilter = { owner: { id: { _eq: '$CURRENT_USER' } } };

						for (const action of ['update', 'delete'] as const) {
							const created = await asAdminPost('/permissions', {
								role: alphaRole.id,
								collection,
								action,
								fields: ['*'],
								permissions: ownFilter,
							});

							expect(created.statusCode).toBe(200);
						}

						await ready({ ownedFirst, ownedSecond, foreign });
					} finally {
						const failures: string[] = [];

						for (const cleanup of cleanups.reverse()) {
							const result = await cleanup.run();
							if (!result.ok) failures.push(result.reason);
						}

						if (failures.length)
							teardownFailures.push(new Error('Permission fixture cleanup failed: ' + failures.join(', ')));
					}
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	scenario: [
		async ({ api, identities, scenarioState, task, skip }, use) => {
			void api;
			void identities;
			await use(requirePrerequisite(scenarioState, 'permission scenario', { task, skip }));
		},
		{ auto: true },
	],
});

describe('items batch mutation atomicity', () => {
	const readRows = async (api: Api, ids: number[]) => {
		const read = await request(api.url)
			.get(`/items/${collection}?filter[id][_in]=${ids.join(',')}&fields=id,title&sort=id`)
			.set('Authorization', `Bearer ${adminToken}`);

		expect(read.statusCode).toBe(200);
		return read.body.data as Array<{ id: number; title: string }>;
	};

	test('enforces atomic all-or-nothing batch mutation for a conditional role', async ({ api, scenario }) => {
		const url = api.url;
		const first = scenario.ownedFirst;
		const second = scenario.ownedSecond;
		const other = scenario.foreign;

		const allOwnedUpdate = await request(url)
			.patch(`/items/${collection}`)
			.set('Authorization', `Bearer ${alphaToken}`)
			.send({ keys: [first, second], data: { title: 'batch-updated' } });

		expect(allOwnedUpdate.statusCode).toBe(204);

		const afterOwnedUpdate = await readRows(api, [first, second]);
		expect(afterOwnedUpdate.map((row) => row.title)).toEqual(['batch-updated', 'batch-updated']);

		const mixedUpdate = await request(url)
			.patch(`/items/${collection}`)
			.set('Authorization', `Bearer ${alphaToken}`)
			.send({ keys: [first, other], data: { title: 'should-not-apply' } });

		expect(mixedUpdate.statusCode).toBe(403);
		expect(mixedUpdate.body.errors[0].extensions.code).toBe('FORBIDDEN');

		const afterMixedUpdate = await readRows(api, [first, other]);
		const titlesById = Object.fromEntries(afterMixedUpdate.map((row) => [row.id, row.title]));
		expect(titlesById[first]).toBe('batch-updated');
		expect(titlesById[other]).toBe('beta-1');

		const mixedDelete = await request(url)
			.delete(`/items/${collection}`)
			.set('Authorization', `Bearer ${alphaToken}`)
			.send([second, other]);

		expect(mixedDelete.statusCode).toBe(403);
		expect(mixedDelete.body.errors[0].extensions.code).toBe('FORBIDDEN');

		const afterMixedDelete = await readRows(api, [second, other]);
		expect(afterMixedDelete.map((row) => row.id)).toEqual([second, other].sort((a, b) => a - b));

		const allOwnedDelete = await request(url)
			.delete(`/items/${collection}`)
			.set('Authorization', `Bearer ${alphaToken}`)
			.send([first, second]);

		expect(allOwnedDelete.statusCode).toBe(204);

		const afterOwnedDelete = await readRows(api, [first, second, other]);
		expect(afterOwnedDelete.map((row) => row.id)).toEqual([other]);
	}, 60000);
});
