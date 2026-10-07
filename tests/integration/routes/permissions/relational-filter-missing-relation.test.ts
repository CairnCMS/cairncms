import { describe, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection, CreateFieldM2O, CreateFieldO2M, CreateRole } from '../../fixtures/schema';
import request, { CreateItem, requestGraphQL, setupRequest } from '../../fixtures/request';
import type { Api } from '../../fixtures/environment';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const adminToken = USER.ADMIN!.TOKEN;

const run = randomUUID().slice(0, 8);
const orgs = `rel_filter_orgs_${run}`;
const articles = `rel_filter_articles_${run}`;
const depts = `rel_filter_depts_${run}`;
const teams = `rel_filter_teams_${run}`;
const members = `rel_filter_members_${run}`;
const tenantAToken = `RelFilterTenantA${run}`;
const tenantBToken = `RelFilterTenantB${run}`;
const intactToken = `RelFilterIntact${run}`;
const directToken = `RelFilterDirect${run}`;

type CleanupResult = { ok: true } | { ok: false; reason: string };

async function deleteResource(api: Api, resource: string): Promise<CleanupResult> {
	try {
		if (!api.available()) return { ok: false, reason: 'API unavailable during relational-filter fixture cleanup' };
		const response = await request(api.url).delete(resource).set('Authorization', `Bearer ${api.adminToken}`);

		if (response.statusCode >= 400 && response.statusCode !== 404) {
			return { ok: false, reason: `DELETE ${resource} on ${api.url} returned ${response.statusCode}` };
		}

		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `DELETE ${resource} on ${api.url} threw ${String(error)}` };
	}
}

type Scenario = {
	orgBId: number;
	articleAId: number;
	articleBId: number;
	teamId: number;
	memberAName: string;
	memberBName: string;
};

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

						const asAdmin = {
							post: (path: string, payload: Record<string, unknown>) =>
								setupRequest(url).post(path).set('Authorization', `Bearer ${adminToken}`).send(payload),
							delete: (path: string) => setupRequest(url).delete(path).set('Authorization', `Bearer ${adminToken}`),
						};

						const readAs = (token: string, path: string) =>
							setupRequest(url).get(path).set('Authorization', `Bearer ${token}`);

						const createCollection = async (collection: string, fields: Record<string, unknown>[]) => {
							const created = await CreateCollection(api, { collection, fields });
							cleanups.push({ run: () => deleteResource(api, `/collections/${collection}`) });
							expect(created.collection).toBe(collection);
						};

						const createRoleWithUser = async (name: string, token: string) => {
							const role = await CreateRole(api, { name, appAccessEnabled: false, adminAccessEnabled: false });
							cleanups.push({ run: () => deleteResource(api, `/roles/${role?.id}`) });
							expect(role.id).toBeDefined();

							const user = await asAdmin.post('/users', {
								token,
								email: `${name.replaceAll('_', '-')}@example.com`,
								role: role.id,
							});

							cleanups.push({ run: () => deleteResource(api, `/users/${user.body?.data?.id}`) });
							expect(user.statusCode).toBe(200);
							return role.id as string;
						};

						const grant = async (
							role: string,
							collection: string,
							action: string,
							permissions?: Record<string, unknown>
						) => {
							const created = await asAdmin.post('/permissions', {
								role,
								collection,
								action,
								fields: ['*'],
								...(permissions ? { permissions } : {}),
							});

							expect(created.statusCode).toBe(200);
						};

						await createCollection(orgs, [{ field: 'name', type: 'string' }]);

						await createCollection(articles, [
							{ field: 'title', type: 'string' },
							{ field: 'flag', type: 'string' },
						]);

						await CreateFieldM2O(api, { collection: articles, field: 'org', otherCollection: orgs });
						await CreateFieldM2O(api, { collection: articles, field: 'region', otherCollection: orgs });

						await createCollection(depts, [{ field: 'name', type: 'string' }]);
						await createCollection(teams, [{ field: 'name', type: 'string' }]);
						await createCollection(members, [{ field: 'name', type: 'string' }]);

						await CreateFieldO2M(api, {
							collection: teams,
							field: 'crew',
							otherCollection: members,
							otherField: 'team',
						});

						await CreateFieldM2O(api, { collection: members, field: 'dept', otherCollection: depts });

						const orgA = await CreateItem(api, { collection: orgs, item: { name: 'A' } });
						const orgB = await CreateItem(api, { collection: orgs, item: { name: 'B' } });
						const deptA = await CreateItem(api, { collection: depts, item: { name: 'A' } });
						const deptB = await CreateItem(api, { collection: depts, item: { name: 'B' } });
						const team = await CreateItem(api, { collection: teams, item: { name: 'team' } });

						const articleA = await CreateItem(api, {
							collection: articles,
							item: { title: 'article-a', flag: 'x', org: orgA.id, region: orgA.id },
						});

						const articleB = await CreateItem(api, {
							collection: articles,
							item: { title: 'article-b', flag: 'x', org: orgB.id, region: orgB.id },
						});

						const memberAName = `member-a-${run}`;
						const memberBName = `member-b-${run}`;

						await CreateItem(api, {
							collection: members,
							item: { name: memberAName, team: team.id, dept: deptA.id },
						});

						await CreateItem(api, {
							collection: members,
							item: { name: memberBName, team: team.id, dept: deptB.id },
						});

						for (const [name, token, tenant] of [
							[`rel_filter_tenant_a_${run}`, tenantAToken, 'A'],
							[`rel_filter_tenant_b_${run}`, tenantBToken, 'B'],
						] as const) {
							const role = await createRoleWithUser(name, token);
							const articleFilter = { org: { name: { _eq: tenant } } };

							for (const action of ['read', 'update', 'delete']) {
								await grant(role, articles, action, articleFilter);
							}

							await grant(role, orgs, 'read');
							await grant(role, teams, 'read');
							await grant(role, members, 'read', { dept: { name: { _eq: tenant } } });
						}

						const intactRole = await createRoleWithUser(`rel_filter_intact_${run}`, intactToken);
						await grant(intactRole, articles, 'read', { region: { name: { _eq: 'A' } } });

						const directRole = await createRoleWithUser(`rel_filter_direct_${run}`, directToken);
						await grant(directRole, articles, 'read', { flag: { _eq: 'x' } });

						const preDropA = await readAs(tenantAToken, `/items/${articles}?fields=id`);
						expect(preDropA.statusCode).toBe(200);
						expect(preDropA.body.data).toEqual([{ id: articleA.id }]);

						const preDropB = await readAs(tenantBToken, `/items/${articles}?fields=id`);
						expect(preDropB.statusCode).toBe(200);
						expect(preDropB.body.data).toEqual([{ id: articleB.id }]);

						const preDropIntact = await readAs(intactToken, `/items/${articles}?fields=id`);
						expect(preDropIntact.statusCode).toBe(200);
						expect(preDropIntact.body.data).toEqual([{ id: articleA.id }]);

						const preDropCrew = await readAs(tenantAToken, `/items/${teams}/${team.id}?fields=id,crew.name`);
						expect(preDropCrew.statusCode).toBe(200);
						expect(preDropCrew.body.data.crew).toEqual([{ name: memberAName }]);

						for (const path of [`/fields/${articles}/org`, `/fields/${articles}/flag`, `/fields/${members}/dept`]) {
							const dropped = await asAdmin.delete(path);
							expect(dropped.statusCode).toBe(204);
						}

						await ready({
							orgBId: orgB.id,
							articleAId: articleA.id,
							articleBId: articleB.id,
							teamId: team.id,
							memberAName,
							memberBName,
						});
					} finally {
						const failures: string[] = [];

						for (const cleanup of cleanups.reverse()) {
							const result = await cleanup.run();
							if (!result.ok) failures.push(result.reason);
						}

						if (failures.length)
							teardownFailures.push(new Error('Relational-filter fixture cleanup failed: ' + failures.join(', ')));
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
			await use(requirePrerequisite(scenarioState, 'relational-filter scenario', { task, skip }));
		},
		{ auto: true },
	],
});

function expectRejected(response: { statusCode: number; body: any; text: string }) {
	expect(response.statusCode).toBe(400);
	expect(response.body.errors?.[0]?.extensions?.code).toBe('INVALID_QUERY');
	expect(response.body.errors?.[0]?.message).toBe('Invalid relational filter');
	expect(response.text).not.toMatch(/\b(org|dept)\b/);
	expect(response.text).not.toContain(members);
}

async function createTarget(api: Api, scenario: Scenario, title: string) {
	const target = await CreateItem(api, { collection: articles, item: { title, region: scenario.orgBId } });
	expect(target.id).toBeDefined();
	return target.id as number;
}

async function readAsAdmin(api: Api, id: number) {
	return request(api.url).get(`/items/${articles}/${id}`).set('Authorization', `Bearer ${adminToken}`);
}

async function removeTarget(api: Api, id: number) {
	const existing = await readAsAdmin(api, id);
	if (existing.statusCode !== 200) return;

	const removed = await request(api.url)
		.delete(`/items/${articles}/${id}`)
		.set('Authorization', `Bearer ${adminToken}`);

	expect(removed.statusCode).toBe(204);
}

describe('permission filters through a removed relation', () => {
	test('rejects a read instead of returning other tenants items', async ({ api, scenario }) => {
		const response = await request(api.url)
			.get(`/items/${articles}?fields=id`)
			.set('Authorization', `Bearer ${tenantAToken}`);

		expect(response.body.data ?? []).not.toContainEqual({ id: scenario.articleBId });
		expectRejected(response);
	});

	test('rejects the second tenant symmetrically', async ({ api, scenario }) => {
		const response = await request(api.url)
			.get(`/items/${articles}?fields=id`)
			.set('Authorization', `Bearer ${tenantBToken}`);

		expect(response.body.data ?? []).not.toContainEqual({ id: scenario.articleAId });
		expectRejected(response);
	});

	test('rejects an update and leaves the item unchanged', async ({ api, scenario }) => {
		const id = await createTarget(api, scenario, `update-target-${run}`);

		try {
			const response = await request(api.url)
				.patch(`/items/${articles}/${id}`)
				.set('Authorization', `Bearer ${tenantAToken}`)
				.send({ title: 'changed-by-tenant-a' });

			const after = await readAsAdmin(api, id);
			expect(after.statusCode).toBe(200);
			expect(after.body.data.title).toBe(`update-target-${run}`);
			expectRejected(response);
		} finally {
			await removeTarget(api, id);
		}
	});

	test('rejects a delete and leaves the item in place', async ({ api, scenario }) => {
		const id = await createTarget(api, scenario, `delete-target-${run}`);

		try {
			const response = await request(api.url)
				.delete(`/items/${articles}/${id}`)
				.set('Authorization', `Bearer ${tenantAToken}`);

			const after = await readAsAdmin(api, id);
			expect(after.statusCode).toBe(200);
			expectRejected(response);
		} finally {
			await removeTarget(api, id);
		}
	});

	test('rejects an aggregate count instead of counting other tenants items', async ({ api }) => {
		const response = await request(api.url)
			.get(`/items/${articles}?aggregate[count]=*`)
			.set('Authorization', `Bearer ${tenantAToken}`);

		expect(response.body.data).toBeUndefined();
		expectRejected(response);
	});

	test('rejects a GraphQL read with INVALID_QUERY and returns no items', async ({ api }) => {
		const response = await requestGraphQL(api.url, false, tenantAToken, {
			query: { [articles]: { id: true } },
		});

		expect(response.body.data?.[articles] ?? []).toEqual([]);
		expect(response.body.errors?.[0]?.extensions?.code).toBe('INVALID_QUERY');
		expect(response.body.errors?.[0]?.message).toBe('Invalid relational filter');
		expect(response.text).not.toMatch(/\b(org|dept)\b/);
	});

	test('rejects a nested read instead of returning other tenants related items', async ({ api, scenario }) => {
		const response = await request(api.url)
			.get(`/items/${teams}/${scenario.teamId}?fields=id,crew.name`)
			.set('Authorization', `Bearer ${tenantAToken}`);

		expect(response.text).not.toContain(scenario.memberBName);
		expectRejected(response);
	});

	test('rejects a relational count instead of counting other tenants related items', async ({ api, scenario }) => {
		const response = await request(api.url)
			.get(`/items/${teams}/${scenario.teamId}?fields=id,count(crew)`)
			.set('Authorization', `Bearer ${tenantAToken}`);

		expect(response.body.data).toBeUndefined();
		expectRejected(response);
	});

	test('rejects a read that requests metadata counts and returns no counts', async ({ api }) => {
		const response = await request(api.url)
			.get(`/items/${articles}?fields=id&meta=total_count,filter_count`)
			.set('Authorization', `Bearer ${tenantAToken}`);

		expect(response.body.meta).toBeUndefined();
		expectRejected(response);
	});
});

describe('controls', () => {
	test('administrators still read every item after the drop', async ({ api, scenario }) => {
		const response = await request(api.url)
			.get(`/items/${articles}?fields=id`)
			.set('Authorization', `Bearer ${adminToken}`);

		expect(response.statusCode).toBe(200);

		expect(response.body.data).toEqual(
			expect.arrayContaining([{ id: scenario.articleAId }, { id: scenario.articleBId }])
		);
	});

	test('a permission filter through an intact relation still filters', async ({ api, scenario }) => {
		const response = await request(api.url)
			.get(`/items/${articles}?fields=id`)
			.set('Authorization', `Bearer ${intactToken}`);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual([{ id: scenario.articleAId }]);
	});

	test('a permission filter on a removed direct field is rejected', async ({ api }) => {
		const response = await request(api.url)
			.get(`/items/${articles}?fields=id`)
			.set('Authorization', `Bearer ${directToken}`);

		expect(response.statusCode).toBe(400);
		expect(response.body.errors?.[0]?.extensions?.code).toBe('INVALID_QUERY');
		expect(response.body.data).toBeUndefined();
	});
});
