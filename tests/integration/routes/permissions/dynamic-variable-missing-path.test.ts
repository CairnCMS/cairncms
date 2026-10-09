import { describe, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection, CreateField, CreateFieldM2O, CreateRole } from '../../fixtures/schema';
import request, { CreateItem, requestGraphQL, setupRequest } from '../../fixtures/request';
import type { Api } from '../../fixtures/environment';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const adminToken = USER.ADMIN!.TOKEN;

const run = randomUUID().slice(0, 8);
const orgs = `dyn_var_orgs_${run}`;
const articles = `dyn_var_articles_${run}`;
const userPathToken = `DynVarUserPath${run}`;
const validationToken = `DynVarValidation${run}`;
const presetToken = `DynVarPreset${run}`;
const rolePathToken = `DynVarRolePath${run}`;
const plainFieldToken = `DynVarPlainField${run}`;
const sameRoleToken = `DynVarSameRole${run}`;
const mergedToken = `DynVarMerged${run}`;
const repairToken = `DynVarRepair${run}`;
const intactToken = `DynVarIntact${run}`;
const emptyValueToken = `DynVarEmptyValue${run}`;

type CleanupResult = { ok: true } | { ok: false; reason: string };

async function deleteResource(api: Api, resource: string): Promise<CleanupResult> {
	try {
		if (!api.available()) return { ok: false, reason: 'API unavailable during dynamic-variable fixture cleanup' };
		const response = await request(api.url).delete(resource).set('Authorization', `Bearer ${api.adminToken}`);

		if (response.statusCode >= 400 && response.statusCode !== 404) {
			return { ok: false, reason: `DELETE ${resource} on ${api.url} returned ${response.statusCode}` };
		}

		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `DELETE ${resource} on ${api.url} threw ${String(error)}` };
	}
}

async function deleteFieldIfPresent(api: Api, collection: string, field: string): Promise<CleanupResult> {
	try {
		if (!api.available()) return { ok: false, reason: 'API unavailable during dynamic-variable fixture cleanup' };

		const existing = await request(api.url)
			.get(`/fields/${collection}/${field}`)
			.set('Authorization', `Bearer ${api.adminToken}`);

		if (existing.statusCode !== 200) return { ok: true };

		return deleteResource(api, `/fields/${collection}/${field}`);
	} catch (error) {
		return { ok: false, reason: `GET /fields/${collection}/${field} on ${api.url} threw ${String(error)}` };
	}
}

type Scenario = {
	articleAId: number;
	articleBId: number;
	repairPermissionId: number;
};

const test = createIdentityTest({
	env: {
		CACHE_ENABLED: 'true',
		CACHE_AUTO_PURGE: 'true',
		CACHE_STORE: 'memory',
		CACHE_NAMESPACE: `cairncms-dyn-var-${run}`,
	},
}).extend<{ scenarioState: Prerequisite<Scenario>; scenario: Scenario }>({
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

						const asAdmin = {
							post: (path: string, payload: Record<string, unknown>) =>
								setupRequest(url).post(path).set('Authorization', `Bearer ${adminToken}`).send(payload),
							patch: (path: string, payload: Record<string, unknown>) =>
								setupRequest(url).patch(path).set('Authorization', `Bearer ${adminToken}`).send(payload),
							delete: (path: string) => setupRequest(url).delete(path).set('Authorization', `Bearer ${adminToken}`),
						};

						const readAs = (token: string, path = `/items/${articles}?fields=id`) =>
							setupRequest(url).get(path).set('Authorization', `Bearer ${token}`);

						const createCollection = async (collection: string, fields: Record<string, unknown>[]) => {
							const created = await CreateCollection(api, { collection, fields });
							cleanups.push({ run: () => deleteResource(api, `/collections/${collection}`) });
							expect(created.collection).toBe(collection);
						};

						const createRoleWithUser = async (
							name: string,
							token: string,
							user: Record<string, unknown> = {},
							appAccessEnabled = false
						) => {
							const role = await CreateRole(api, { name, appAccessEnabled, adminAccessEnabled: false });
							cleanups.push({ run: () => deleteResource(api, `/roles/${role?.id}`) });
							expect(role.id).toBeDefined();

							const created = await asAdmin.post('/users', {
								token,
								email: `${name.replaceAll('_', '-')}@example.com`,
								role: role.id,
								...user,
							});

							cleanups.push({ run: () => deleteResource(api, `/users/${created.body?.data?.id}`) });
							expect(created.statusCode).toBe(200);
							return role.id as string;
						};

						const grant = async (
							role: string,
							action: string,
							rule: Record<string, unknown>,
							collection = articles
						) => {
							const created = await asAdmin.post('/permissions', { role, collection, action, ...rule });
							expect(created.statusCode).toBe(200);
							return created.body.data.id as number;
						};

						await createCollection(orgs, [
							{ field: 'name', type: 'string' },
							{ field: 'blocked_tenant', type: 'string' },
						]);

						await createCollection(articles, [
							{ field: 'title', type: 'string' },
							{ field: 'tenant', type: 'string' },
						]);

						for (const [collection, field] of [
							['directus_users', 'org'],
							['directus_users', 'home'],
							['directus_roles', 'org'],
						] as const) {
							await CreateFieldM2O(api, { collection, field, otherCollection: orgs });
							cleanups.push({ run: () => deleteFieldIfPresent(api, collection, field) });
						}

						await CreateField(api, {
							collection: 'directus_users',
							field: 'blocked_tenant',
							type: 'string',
							meta: {},
							schema: {},
						});

						cleanups.push({ run: () => deleteFieldIfPresent(api, 'directus_users', 'blocked_tenant') });

						const orgA = await CreateItem(api, { collection: orgs, item: { name: 'A', blocked_tenant: 'B' } });

						const articleA = await CreateItem(api, { collection: articles, item: { title: 'article-a', tenant: 'A' } });
						const articleB = await CreateItem(api, { collection: articles, item: { title: 'article-b', tenant: 'B' } });

						const excludeBlocked = (variable: string) => ({ tenant: { _neq: variable } });

						const userPathRole = await createRoleWithUser(`dyn_var_user_path_${run}`, userPathToken, {
							org: orgA.id,
						});

						await grant(userPathRole, 'read', {
							fields: ['*'],
							permissions: excludeBlocked('$CURRENT_USER.org.blocked_tenant'),
						});

						const validationRole = await createRoleWithUser(`dyn_var_validation_${run}`, validationToken, {
							org: orgA.id,
						});

						await grant(validationRole, 'create', {
							fields: ['*'],
							validation: excludeBlocked('$CURRENT_USER.org.blocked_tenant'),
						});

						const presetRole = await createRoleWithUser(`dyn_var_preset_${run}`, presetToken, { org: orgA.id });

						await grant(presetRole, 'create', {
							fields: ['title'],
							presets: { tenant: '$CURRENT_USER.org.name' },
						});

						const rolePathRole = await createRoleWithUser(`dyn_var_role_path_${run}`, rolePathToken);
						const roleOrg = await asAdmin.patch(`/roles/${rolePathRole}`, { org: orgA.id });
						expect(roleOrg.statusCode).toBe(200);

						await grant(rolePathRole, 'read', {
							fields: ['*'],
							permissions: excludeBlocked('$CURRENT_ROLE.org.blocked_tenant'),
						});

						const plainFieldRole = await createRoleWithUser(`dyn_var_plain_field_${run}`, plainFieldToken, {
							blocked_tenant: 'B',
						});

						await grant(plainFieldRole, 'read', {
							fields: ['*'],
							permissions: excludeBlocked('$CURRENT_USER.blocked_tenant'),
						});

						const sameRole = await createRoleWithUser(
							`dyn_var_same_role_${run}`,
							sameRoleToken,
							{ org: orgA.id },
							true
						);

						await grant(sameRole, 'read', {
							fields: ['*'],
							permissions: excludeBlocked('$CURRENT_USER.org.blocked_tenant'),
						});

						await grant(sameRole, 'read', { fields: ['*'] }, orgs);

						const mergedRole = await createRoleWithUser(`dyn_var_merged_${run}`, mergedToken, { org: orgA.id }, true);

						await grant(
							mergedRole,
							'read',
							{ fields: ['*'], permissions: { email: { _neq: '$CURRENT_USER.org.name' } } },
							'directus_users'
						);

						const repairRole = await createRoleWithUser(`dyn_var_repair_${run}`, repairToken, {
							org: orgA.id,
							home: orgA.id,
						});

						const repairPermissionId = await grant(repairRole, 'read', {
							fields: ['*'],
							permissions: excludeBlocked('$CURRENT_USER.org.blocked_tenant'),
						});

						const intactRole = await createRoleWithUser(`dyn_var_intact_${run}`, intactToken, { home: orgA.id });

						await grant(intactRole, 'read', {
							fields: ['*'],
							permissions: excludeBlocked('$CURRENT_USER.home.blocked_tenant'),
						});

						const emptyValueRole = await createRoleWithUser(`dyn_var_empty_value_${run}`, emptyValueToken);

						await grant(emptyValueRole, 'read', {
							fields: ['*'],
							permissions: excludeBlocked('$CURRENT_USER.home.blocked_tenant'),
						});

						for (const token of [
							userPathToken,
							rolePathToken,
							plainFieldToken,
							sameRoleToken,
							repairToken,
							intactToken,
						]) {
							const before = await readAs(token);
							expect(before.statusCode).toBe(200);
							expect(before.body.data).toEqual([{ id: articleA.id }]);
						}

						const emptyBefore = await readAs(emptyValueToken);
						expect(emptyBefore.statusCode).toBe(200);
						expect(emptyBefore.body.data).toEqual([{ id: articleA.id }, { id: articleB.id }]);

						const mergedBefore = await readAs(mergedToken, '/users?fields=id');
						expect(mergedBefore.statusCode).toBe(200);
						expect(mergedBefore.body.data.length).toBeGreaterThan(0);

						const rejectedBefore = await request(url)
							.post(`/items/${articles}`)
							.set('Authorization', `Bearer ${validationToken}`)
							.send({ title: `rejected-before-${run}`, tenant: 'B' });

						expect(rejectedBefore.statusCode).toBe(400);

						const presetBefore = await setupRequest(url)
							.post(`/items/${articles}`)
							.set('Authorization', `Bearer ${presetToken}`)
							.send({ title: `preset-before-${run}` });

						expect(presetBefore.statusCode).toBe(204);

						const presetItem = await setupRequest(url)
							.get(`/items/${articles}`)
							.query({ filter: JSON.stringify({ title: { _eq: `preset-before-${run}` } }), fields: 'id,tenant' })
							.set('Authorization', `Bearer ${adminToken}`);

						expect(presetItem.body.data).toEqual([{ id: expect.any(Number), tenant: 'A' }]);
						const removedPresetItem = await asAdmin.delete(`/items/${articles}/${presetItem.body.data[0].id}`);
						expect(removedPresetItem.statusCode).toBe(204);

						for (const path of [
							'/fields/directus_users/org',
							'/fields/directus_roles/org',
							'/fields/directus_users/blocked_tenant',
						]) {
							const dropped = await asAdmin.delete(path);
							expect(dropped.statusCode).toBe(204);
						}

						await ready({ articleAId: articleA.id, articleBId: articleB.id, repairPermissionId });
					} finally {
						const failures: string[] = [];

						for (const cleanup of cleanups.reverse()) {
							const result = await cleanup.run();
							if (!result.ok) failures.push(result.reason);
						}

						if (failures.length)
							teardownFailures.push(new Error('Dynamic-variable fixture cleanup failed: ' + failures.join(', ')));
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
			await use(requirePrerequisite(scenarioState, 'dynamic-variable scenario', { task, skip }));
		},
		{ auto: true },
	],
});

async function readAs(api: Api, token: string, path = `/items/${articles}?fields=id`) {
	return request(api.url).get(path).set('Authorization', `Bearer ${token}`);
}

async function articlesTitled(api: Api, title: string) {
	const response = await request(api.url)
		.get(`/items/${articles}`)
		.query({ filter: JSON.stringify({ title: { _eq: title } }), fields: 'id,tenant' })
		.set('Authorization', `Bearer ${adminToken}`);

	expect(response.statusCode).toBe(200);
	return response.body.data as Array<{ id: number; tenant: string | null }>;
}

async function removeArticles(api: Api, title: string) {
	for (const { id } of await articlesTitled(api, title)) {
		await request(api.url).delete(`/items/${articles}/${id}`).set('Authorization', `Bearer ${adminToken}`);
	}
}

function expectForbidden(response: { statusCode: number; body: any }) {
	expect(response.statusCode).toBe(403);
	expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
	expect(response.body.data).toBeUndefined();
}

async function expectReadDenied(api: Api, token: string, scenario: Scenario) {
	for (const attempt of ['uncached', 'cached']) {
		const response = await readAs(api, token);

		expect(response.body.data ?? [], attempt).not.toContainEqual({ id: scenario.articleBId });
		expectForbidden(response);
	}
}

async function expectCreateDenied(api: Api, token: string, title: string, item: Record<string, unknown>) {
	try {
		for (const attempt of ['uncached', 'cached']) {
			const response = await request(api.url)
				.post(`/items/${articles}`)
				.set('Authorization', `Bearer ${token}`)
				.send({ title, ...item });

			expect(await articlesTitled(api, title), attempt).toEqual([]);
			expectForbidden(response);
		}
	} finally {
		await removeArticles(api, title);
	}
}

describe('dynamic variables whose path was removed', () => {
	test('a read filter through a removed user relation denies the read', async ({ api, scenario }) => {
		await expectReadDenied(api, userPathToken, scenario);
	});

	test('a read filter through a removed role relation denies the read', async ({ api, scenario }) => {
		await expectReadDenied(api, rolePathToken, scenario);
	});

	test('a read filter on a removed user field denies the read', async ({ api, scenario }) => {
		await expectReadDenied(api, plainFieldToken, scenario);
	});

	test('a validation rule through a removed relation denies the create', async ({ api }) => {
		await expectCreateDenied(api, validationToken, `validation-target-${run}`, { tenant: 'B' });
	});

	test('a preset through a removed relation denies the create', async ({ api }) => {
		await expectCreateDenied(api, presetToken, `preset-target-${run}`, {});
	});

	test('a GraphQL read through a removed relation returns no items', async ({ api, scenario }) => {
		const response = await requestGraphQL(api.url, false, userPathToken, {
			query: { [articles]: { id: true } },
		});

		expect(response.text).not.toContain(`"id":${scenario.articleBId}`);
		expect(response.body.data?.[articles] ?? []).toEqual([]);
		expect(response.body.errors?.length).toBeGreaterThan(0);
	});

	test('a permission merged with the app access defaults is denied as a whole', async ({ api }) => {
		for (const attempt of ['uncached', 'cached']) {
			const response = await readAs(api, mergedToken, '/users?fields=id');

			expect(response.statusCode, attempt).toBe(403);
			expect(response.body.data).toBeUndefined();
		}
	});
});

describe('isolation and recovery', () => {
	test('other permissions on the same role keep working', async ({ api, scenario }) => {
		await expectReadDenied(api, sameRoleToken, scenario);

		const orgsRead = await readAs(api, sameRoleToken, `/items/${orgs}?fields=name`);
		expect(orgsRead.statusCode).toBe(200);
		expect(orgsRead.body.data).toEqual([{ name: 'A' }]);

		const me = await readAs(api, sameRoleToken, '/users/me?fields=id,email');
		expect(me.statusCode).toBe(200);
		expect(me.body.data.email).toBe(`dyn-var-same-role-${run}@example.com`);
	});

	test('repairing the permission restores access', async ({ api, scenario }) => {
		await expectReadDenied(api, repairToken, scenario);

		const repaired = await request(api.url)
			.patch(`/permissions/${scenario.repairPermissionId}`)
			.set('Authorization', `Bearer ${adminToken}`)
			.send({ permissions: { tenant: { _neq: '$CURRENT_USER.home.blocked_tenant' } } });

		expect(repaired.statusCode).toBe(200);

		for (const attempt of ['uncached', 'cached']) {
			const response = await readAs(api, repairToken);

			expect(response.statusCode, attempt).toBe(200);
			expect(response.body.data).toEqual([{ id: scenario.articleAId }]);
		}
	});
});

describe('controls', () => {
	test('a dynamic variable through an intact relation still filters', async ({ api, scenario }) => {
		const response = await readAs(api, intactToken);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual([{ id: scenario.articleAId }]);
	});

	test('a dynamic variable whose value is empty keeps its existing result', async ({ api, scenario }) => {
		const response = await readAs(api, emptyValueToken);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual([{ id: scenario.articleAId }, { id: scenario.articleBId }]);
	});

	test('administrators still read every item after the drop', async ({ api, scenario }) => {
		const response = await request(api.url)
			.get(`/items/${articles}?fields=id`)
			.set('Authorization', `Bearer ${adminToken}`);

		expect(response.statusCode).toBe(200);

		expect(response.body.data).toEqual(
			expect.arrayContaining([{ id: scenario.articleAId }, { id: scenario.articleBId }])
		);
	});
});
