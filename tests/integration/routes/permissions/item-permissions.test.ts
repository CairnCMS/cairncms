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
const collection = `test_item_perms_${run}`;
const singletonCollection = `test_item_perms_singleton_${run}`;
const unknownCollection = `no_such_collection_${run}`;
const alphaRoleName = `item_perms_alpha_${run}`;
const betaRoleName = `item_perms_beta_${run}`;
const sharesRoleName = `item_perms_shares_${run}`;
const singletonRoleName = `item_perms_singleton_${run}`;
const alphaToken = `ItemPermsAlpha${run}`;
const betaToken = `ItemPermsBeta${run}`;
const sharesToken = `ItemPermsShares${run}`;
const singletonToken = `ItemPermsSingleton${run}`;

const denied = {
	update: { access: false, fields: null },
	delete: { access: false },
	share: { access: false },
};

const granted = {
	update: { access: true, fields: ['title'] },
	delete: { access: false },
	share: { access: false },
};

const grantedAll = {
	update: { access: true, fields: ['*'] },
	delete: { access: false },
	share: { access: false },
};

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

type Scenario = { alphaItemId: number; betaItemId: number; shareId: string; shareVisitorToken: string };

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
							fields: [
								{ field: 'title', type: 'string' },
								{ field: 'region', type: 'string' },
							],
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
						const sharesRole = await createRole(sharesRoleName);
						const singletonRole = await createRole(singletonRoleName);

						const alphaUser = await createUser(alphaToken, `item-perms-alpha-${run}@example.com`, alphaRole.id);
						const betaUser = await createUser(betaToken, `item-perms-beta-${run}@example.com`, betaRole.id);
						await createUser(sharesToken, `item-perms-shares-${run}@example.com`, sharesRole.id);
						await createUser(singletonToken, `item-perms-singleton-${run}@example.com`, singletonRole.id);

						const alphaItem = await CreateItem(api, {
							collection,
							item: { title: 'alpha-doc', region: 'north', owner: alphaUser.id },
						});

						const betaItem = await CreateItem(api, {
							collection,
							item: { title: 'beta-doc', region: 'south', owner: betaUser.id },
						});

						expect(alphaItem.id).toBeDefined();
						expect(betaItem.id).toBeDefined();
						const alphaItemId = alphaItem.id;
						const betaItemId = betaItem.id;

						const nestedFilter = {
							_and: [
								{ owner: { id: { _eq: '$CURRENT_USER' } } },
								{ _or: [{ region: { _eq: 'north' } }, { region: { _eq: 'south' } }] },
							],
						};

						for (const roleId of [alphaRole.id, betaRole.id]) {
							const created = await asAdminPost('/permissions', {
								role: roleId,
								collection,
								action: 'update',
								fields: ['title'],
								permissions: nestedFilter,
							});

							expect(created.statusCode).toBe(200);
						}

						const sharePermission = await asAdminPost('/permissions', {
							role: sharesRole.id,
							collection: 'directus_shares',
							action: 'update',
							fields: ['*'],
						});

						expect(sharePermission.statusCode).toBe(200);

						const share = await asAdminPost('/shares', {
							collection,
							item: alphaItem.id,
							role: sharesRole.id,
							name: `item-perms-share-${run}`,
						});

						const shareId = share.body?.data?.id;
						cleanups.push({ run: () => deleteResource(api, `/shares/${shareId}`) });
						expect(share.statusCode).toBe(200);
						expect(shareId).toBeDefined();

						const shareAuth = await setupRequest(url).post('/shares/auth').send({ share: shareId });
						const shareVisitorToken = shareAuth.body?.data?.access_token;
						expect(shareAuth.statusCode).toBe(200);
						expect(typeof shareVisitorToken).toBe('string');
						expect(shareVisitorToken.length).toBeGreaterThan(0);

						const singleton = await CreateCollection(api, {
							collection: singletonCollection,
							meta: { singleton: true },
							fields: [{ field: 'label', type: 'string' }],
						});

						cleanups.push({ run: () => deleteResource(api, `/collections/${singletonCollection}`) });
						expect(singleton.collection).toBe(singletonCollection);

						const singletonPermission = await asAdminPost('/permissions', {
							role: singletonRole.id,
							collection: singletonCollection,
							action: 'update',
							fields: ['*'],
						});

						expect(singletonPermission.statusCode).toBe(200);

						const singletonRow = await setupRequest(url)
							.patch(`/items/${singletonCollection}`)
							.set('Authorization', `Bearer ${adminToken}`)
							.send({ label: 'only' });

						expect(singletonRow.statusCode).toBe(200);
						expect(singletonRow.body.data.label).toBe('only');
						await ready({ alphaItemId, betaItemId, shareId, shareVisitorToken });
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

describe('/permissions/me item permissions', () => {
	const me = (api: Api, target: string, token?: string) => {
		const pending = request(api.url).get(`/permissions/me/${target}`);
		return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
	};

	test('reports a conditional update capability without read access', async ({ api, scenario }) => {
		const read = await request(api.url)
			.get(`/items/${collection}/${scenario.alphaItemId}`)
			.set('Authorization', `Bearer ${alphaToken}`);

		expect(read.statusCode).toBe(403);

		const response = await me(api, `${collection}/${scenario.alphaItemId}`, alphaToken);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual(granted);
	});

	test('conceals a forbidden, missing, malformed, and unknown-collection target behind one response', async ({
		api,
		scenario,
	}) => {
		const inaccessible = await me(api, `${collection}/${scenario.betaItemId}`, alphaToken);
		const nonexistent = await me(api, `${collection}/999999999`, alphaToken);
		const malformed = await me(api, `${collection}/not-a-valid-key`, alphaToken);
		const unknownKeyed = await me(api, `${unknownCollection}/1`, alphaToken);

		for (const response of [inaccessible, nonexistent, malformed, unknownKeyed]) {
			expect(response.statusCode).toBe(200);
			expect(response.body.data).toEqual(denied);
		}

		expect(nonexistent.text).toBe(inaccessible.text);
		expect(malformed.text).toBe(inaccessible.text);
		expect(unknownKeyed.text).toBe(inaccessible.text);
	});

	test('isolates the second tenant symmetrically', async ({ api, scenario }) => {
		const own = await me(api, `${collection}/${scenario.betaItemId}`, betaToken);

		expect(own.statusCode).toBe(200);
		expect(own.body.data).toEqual(granted);

		const other = await me(api, `${collection}/${scenario.alphaItemId}`, betaToken);

		expect(other.statusCode).toBe(200);
		expect(other.body.data).toEqual(denied);
	});

	test('gives an admin no existence oracle', async ({ api, scenario }) => {
		const existing = await me(api, `${collection}/${scenario.alphaItemId}`, adminToken);

		expect(existing.statusCode).toBe(200);

		expect(existing.body.data).toEqual({
			update: { access: true, fields: ['*'] },
			delete: { access: true },
			share: { access: true },
		});

		const missing = await me(api, `${collection}/999999999`, adminToken);

		expect(missing.statusCode).toBe(200);
		expect(missing.body.data).toEqual(denied);
	});

	test('rejects an unauthenticated request before classifying the target', async ({ api }) => {
		const response = await me(api, `${unknownCollection}/not-a-valid-key`);

		expect(response.statusCode).toBe(401);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_CREDENTIALS');
		expect(response.body.data).toBeUndefined();
	});

	test('rejects share accountability', async ({ api, scenario }) => {
		const response = await me(api, `${collection}/${scenario.alphaItemId}`, scenario.shareVisitorToken);

		expect(response.statusCode).toBe(401);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_CREDENTIALS');
		expect(response.body.data).toBeUndefined();
	});

	test('reports a capability result for a directus_shares item', async ({ api, scenario }) => {
		const response = await me(api, `directus_shares/${scenario.shareId}`, sharesToken);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual(grantedAll);
	});

	test('does not disclose collection existence through a keyless request', async ({ api }) => {
		const keylessKnown = await me(api, `${collection}`, alphaToken);
		const keylessUnknown = await me(api, `${unknownCollection}`, alphaToken);

		expect(keylessKnown.statusCode).toBe(400);
		expect(keylessUnknown.statusCode).toBe(400);
		expect(keylessKnown.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(keylessKnown.body.errors[0].message).toBe('A primary key is required');
		expect(keylessKnown.text).toBe(keylessUnknown.text);
	});

	test('resolves a singleton capability without a key', async ({ api }) => {
		const response = await me(api, `${singletonCollection}`, singletonToken);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual(grantedAll);
	});

	test('gives a keyless known singleton and an unknown collection the same response without a relevant permission', async ({
		api,
	}) => {
		const known = await me(api, `${singletonCollection}`, alphaToken);
		const unknown = await me(api, `${unknownCollection}`, alphaToken);

		expect(known.statusCode).toBe(400);
		expect(unknown.statusCode).toBe(400);
		expect(known.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(known.text).toBe(unknown.text);
	});

	test('gives a keyed known collection and an unknown collection the same response without a relevant permission', async ({
		api,
	}) => {
		const known = await me(api, `${collection}/1e3`, sharesToken);
		const unknown = await me(api, `${unknownCollection}/1e3`, sharesToken);

		expect(known.statusCode).toBe(200);
		expect(unknown.statusCode).toBe(200);
		expect(known.body.data).toEqual(denied);
		expect(known.text).toBe(unknown.text);
	});
});
