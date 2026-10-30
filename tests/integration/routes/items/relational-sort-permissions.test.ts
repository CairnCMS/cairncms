import { randomUUID } from 'node:crypto';
import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { CreateItem, setupRequest } from '../../fixtures/request';
import { CreateCollection, CreateFieldM2O, CreateFieldO2M, CreateRole } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const run = randomUUID().slice(0, 8);
const authors = `test_items_sortperm_authors_${run}`;
const posts = `test_items_sortperm_posts_${run}`;
const alphaToken = `SortPermAlpha${run}`;
const betaToken = `SortPermBeta${run}`;

type CleanupResult = { ok: true } | { ok: false; reason: string };

async function deleteResource(api: Api, resource: string): Promise<CleanupResult> {
	try {
		if (!api.available()) return { ok: false, reason: 'API unavailable during relational sort fixture cleanup' };
		const response = await request(api.url).delete(resource).set('Authorization', `Bearer ${api.adminToken}`);

		if (response.statusCode >= 400 && response.statusCode !== 404) {
			return { ok: false, reason: `DELETE ${resource} on ${api.url} returned ${response.statusCode}` };
		}

		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `DELETE ${resource} on ${api.url} threw ${String(error)}` };
	}
}

type Scenario = { alphaAuthors: string[]; betaAuthors: string[] };

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
						const asAdminPost = (path: string, payload: Record<string, unknown>) =>
							setupRequest(api.url).post(path).set('Authorization', `Bearer ${api.adminToken}`).send(payload);

						const authorsCollection = await CreateCollection(api, {
							collection: authors,
							fields: [{ field: 'name', type: 'string' }],
						});

						cleanups.push({ run: () => deleteResource(api, `/collections/${authors}`) });
						expect(authorsCollection.collection).toBe(authors);

						const owner = await CreateFieldM2O(api, {
							collection: authors,
							field: 'owner',
							otherCollection: 'directus_users',
							primaryKeyType: 'uuid',
						});

						expect(owner.relation.related_collection).toBe('directus_users');

						const postsCollection = await CreateCollection(api, {
							collection: posts,
							fields: [{ field: 'title', type: 'string' }],
						});

						cleanups.push({ run: () => deleteResource(api, `/collections/${posts}`) });
						expect(postsCollection.collection).toBe(posts);

						const relation = await CreateFieldO2M(api, {
							collection: authors,
							field: 'posts',
							otherCollection: posts,
							otherField: 'author',
						});

						expect(relation.relation.meta.one_field).toBe('posts');

						const createTenant = async (name: string, token: string) => {
							const role = await CreateRole(api, { name, appAccessEnabled: false, adminAccessEnabled: false });
							cleanups.push({ run: () => deleteResource(api, `/roles/${role?.id}`) });
							expect(role.id).toBeDefined();

							const user = await asAdminPost('/users', { token, email: `${name}@example.com`, role: role.id });
							cleanups.push({ run: () => deleteResource(api, `/users/${user.body?.data?.id}`) });
							expect(user.statusCode).toBe(200);

							const authorsPermission = await asAdminPost('/permissions', {
								role: role.id,
								collection: authors,
								action: 'read',
								fields: ['*'],
								permissions: { owner: { _eq: '$CURRENT_USER' } },
							});

							expect(authorsPermission.statusCode).toBe(200);

							const postsPermission = await asAdminPost('/permissions', {
								role: role.id,
								collection: posts,
								action: 'read',
								fields: ['*'],
								permissions: { author: { owner: { _eq: '$CURRENT_USER' } } },
							});

							expect(postsPermission.statusCode).toBe(200);
							return user.body.data.id as string;
						};

						const alphaUser = await createTenant(`sortperm_alpha_${run}`, alphaToken);
						const betaUser = await createTenant(`sortperm_beta_${run}`, betaToken);

						const seed: Array<{ name: string; owner: string; titles: string[] }> = [
							{ name: 'A1', owner: alphaUser, titles: ['m', 'x'] },
							{ name: 'A2', owner: alphaUser, titles: ['c'] },
							{ name: 'B1', owner: betaUser, titles: ['a'] },
							{ name: 'B2', owner: betaUser, titles: ['z'] },
						];

						for (const author of seed) {
							const created = await CreateItem(api, {
								collection: authors,
								item: { name: author.name, owner: author.owner },
							});

							for (const title of author.titles) {
								await CreateItem(api, { collection: posts, item: { title, author: created.id } });
							}
						}

						await ready({ alphaAuthors: ['A1', 'A2'], betaAuthors: ['B1', 'B2'] });
					} finally {
						const failures: string[] = [];

						for (const cleanup of cleanups.reverse()) {
							const result = await cleanup.run();
							if (!result.ok) failures.push(result.reason);
						}

						if (failures.length)
							teardownFailures.push(new Error('Relational sort fixture cleanup failed: ' + failures.join(', ')));
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
			await use(requirePrerequisite(scenarioState, 'relational sort scenario', { task, skip }));
		},
		{ auto: true },
	],
});

async function readAuthorNames(api: Api, token: string, query: Record<string, unknown>): Promise<string[]> {
	const response = await request(api.url)
		.get(`/items/${authors}`)
		.query({ fields: 'name', ...query })
		.set('Authorization', `Bearer ${token}`);

	expect(response.statusCode).toBe(200);
	return response.body.data.map((item: { name: string }) => item.name);
}

describe('relational sort under row permissions', () => {
	test('sorts every tenant together for an admin', async ({ api }) => {
		expect(await readAuthorNames(api, api.adminToken, { sort: 'posts.title', limit: 1 })).toEqual(['B1']);
	});

	test('returns the first own row for an ascending sort with a limit', async ({ api, scenario }) => {
		const names = await readAuthorNames(api, alphaToken, { sort: 'posts.title', limit: 1 });

		expect(names).toEqual(['A2']);
		expect(scenario.alphaAuthors).toEqual(expect.arrayContaining(names));
	});

	test('returns own rows in order for a descending sort with a limit', async ({ api, scenario }) => {
		const names = await readAuthorNames(api, alphaToken, { sort: '-posts.title', limit: 2 });

		expect(names).toEqual(['A1', 'A2']);
		expect(scenario.alphaAuthors).toEqual(expect.arrayContaining(names));
	});

	test('isolates the second tenant symmetrically', async ({ api, scenario }) => {
		const names = await readAuthorNames(api, betaToken, { sort: 'posts.title', limit: 5 });

		expect(names).toEqual(['B1', 'B2']);
		expect(scenario.betaAuthors).toEqual(expect.arrayContaining(names));
	});

	test('returns no rows for a relational filter that matches only another tenant', async ({ api }) => {
		const names = await readAuthorNames(api, alphaToken, {
			sort: 'posts.title',
			filter: { posts: { title: { _eq: 'a' } } },
		});

		expect(names).toEqual([]);
	});
});
