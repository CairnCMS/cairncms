import { setupRequest } from '../../fixtures/request';
import { describe, expect, inject } from 'vitest';
import { apiTest, type Api } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection, CreateField, CreateFieldM2M } from '../../fixtures/schema';
import request from '../../fixtures/request';
import { randomUUID } from 'node:crypto';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const vendor = inject('integration').vendor;
const runId = randomUUID().slice(0, 8);
type Register = (fn: () => Promise<void>) => void;

async function createRole(api: Api, name: string, register: Register): Promise<string> {
	const role = await setupRequest(api.url)
		.post('/roles')
		.send({ name, admin_access: false, app_access: true })
		.set('Authorization', `Bearer ${api.adminToken}`);

	const roleId = role.body?.data?.id as string | undefined;

	if (roleId) {
		register(async () => {
			await request(api.url).delete(`/roles/${roleId}`).set('Authorization', `Bearer ${api.adminToken}`);
		});
	}

	expect(role.statusCode).toBe(200);

	return roleId!;
}

async function createUser(api: Api, roleId: string, token: string, email: string, register: Register): Promise<string> {
	const user = await setupRequest(api.url)
		.post('/users')
		.send({ email, password: 'Fr2bPassword', token, role: roleId, status: 'active' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	const userId = user.body?.data?.id as string | undefined;

	if (userId) {
		register(async () => {
			await request(api.url).delete(`/users/${userId}`).set('Authorization', `Bearer ${api.adminToken}`);
		});
	}

	expect(user.statusCode).toBe(200);

	return userId!;
}

async function createRoleUser(
	api: Api,
	name: string,
	token: string,
	email: string,
	register: Register
): Promise<string> {
	const roleId = await createRole(api, name, register);
	await createUser(api, roleId, token, email, register);
	return roleId;
}

async function grant(
	api: Api,
	roleId: string,
	collection: string,
	action: string,
	fields: readonly string[],
	permissions: Record<string, any> = {},
	presets: Record<string, any> | null = null,
	validation: Record<string, any> | null = null
): Promise<void> {
	const response = await setupRequest(api.url)
		.post('/permissions')
		.send({ role: roleId, collection, action, fields, permissions, presets, validation })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);
}

const m2mParent = `test_fr2b_m2m_parent_${runId}`;
const tagCollection = `test_fr2b_tag_${runId}`;
const junctionCollection = `test_fr2b_ptag_${runId}`;
const reverseField = `${m2mParent}_id`;
const tagField = `${tagCollection}_id`;
const junctionToken = `Fr2bJunction_${runId}`;
const m2mParentUpdateOnlyToken = `Fr2bM2mParentOnly_${runId}`;
type Scenario = { parent: string; junction: string; tag: string; existingTag: string };

async function createRows(api: Api): Promise<Scenario> {
	const created = await setupRequest(api.url)
		.post(`/items/${m2mParent}`)
		.send({ name: 'M2M parent', tags: { create: [{ label: 'Original label', [tagField]: { name: 'Tag A' } }] } })
		.query({ fields: `id,tags.id,tags.${tagField}` })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(created.statusCode).toBe(200);

	const existingTag = await setupRequest(api.url)
		.post(`/items/${tagCollection}`)
		.send({ name: 'Existing selectable tag' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(existingTag.statusCode).toBe(200);
	return {
		parent: created.body.data.id,
		junction: created.body.data.tags[0].id,
		tag: created.body.data.tags[0][tagField],
		existingTag: existingTag.body.data.id,
	};
}

const test = apiTest.extend<{ schemaState: Prerequisite<void>; scenario: Scenario }>({
	schemaState: [
		async ({ apiState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					const cleanups: Array<() => Promise<void>> = [];

					const track = (fn: () => Promise<void>) => {
						cleanups.push(fn);
					};

					try {
						const m2mColl = await CreateCollection(api, { collection: m2mParent });

						track(async () => {
							await request(api.url)
								.delete(`/collections/${m2mParent}`)
								.set('Authorization', `Bearer ${api.adminToken}`);
						});

						expect(m2mColl.collection).toBe(m2mParent);
						const tagColl = await CreateCollection(api, { collection: tagCollection });

						track(async () => {
							await request(api.url)
								.delete(`/collections/${tagCollection}`)
								.set('Authorization', `Bearer ${api.adminToken}`);
						});

						expect(tagColl.collection).toBe(tagCollection);
						await CreateField(api, { collection: m2mParent, field: 'name', type: 'string' });
						await CreateField(api, { collection: tagCollection, field: 'name', type: 'string' });

						const m2m = await CreateFieldM2M(api, {
							collection: m2mParent,
							field: 'tags',
							otherCollection: tagCollection,
							otherField: 'parents',
							junctionCollection,
							primaryKeyType: 'integer',
						});

						track(async () => {
							await request(api.url)
								.delete(`/collections/${junctionCollection}`)
								.set('Authorization', `Bearer ${api.adminToken}`);
						});

						expect(m2m.junctionCollection).toBeDefined();

						const label = await CreateField(api, {
							collection: junctionCollection,
							field: 'label',
							type: 'string',
						});

						expect(label.field).toBe('label');

						const roleId = await createRoleUser(
							api,
							`FR2b Junction ${runId}`,
							junctionToken,
							`fr2b-junction-${runId}-${vendor}@tests.com`,
							track
						);

						for (const [collection, action, fields] of [
							[m2mParent, 'read', ['*']],
							[m2mParent, 'update', ['*']],
							[m2mParent, 'create', ['*']],
							// The parent link must not be rewritten on update, but create authorizes the injected reverse field.
							[junctionCollection, 'update', ['label', tagField]],
							[junctionCollection, 'create', ['label', tagField, reverseField]],
							[tagCollection, 'update', ['name']],
							[tagCollection, 'create', ['name']],
						] as const) {
							await grant(api, roleId, collection, action, fields);
						}

						const m2mParentUpdateOnlyRole = await createRoleUser(
							api,
							`FR2b M2M Parent Update Only ${runId}`,
							m2mParentUpdateOnlyToken,
							`fr2b-m2mparentupdateonly-${runId}-${vendor}@tests.com`,
							track
						);

						await grant(api, m2mParentUpdateOnlyRole, m2mParent, 'update', ['*']);

						await ready();
					} finally {
						if (api.available())
							for (const cleanup of cleanups.reverse()) {
								try {
									await cleanup();
								} catch (error) {
									teardownFailures.push(error);
								}
							}
					}
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	scenario: [
		async ({ api, schemaState, task, skip }, use) => {
			requirePrerequisite(schemaState, 'nested-write schema and permissions', { task, skip });
			// Rows are independent, while real API writes still produce the revisions under test.
			for (const table of [junctionCollection, m2mParent, tagCollection]) await api.database(table).delete();
			await api.database('directus_revisions').delete();
			await api.database('directus_activity').delete();
			await use(await createRows(api));
		},
		{ auto: true },
	],
});

describe('Nested junction (m2m) write selector and link separation', () => {
	test('updates junction metadata under a grant excluding the reverse field', async ({ api, scenario }) => {
		const { parent, junction } = scenario;

		const response = await request(api.url)
			.patch(`/items/${m2mParent}/${parent}`)
			.send({ tags: { update: [{ id: junction, label: 'Edited label' }] } })
			.set('Authorization', `Bearer ${junctionToken}`);

		expect(response.statusCode).toBe(200);

		const readBack = await request(api.url)
			.get(`/items/${junctionCollection}/${junction}`)
			.query({ fields: `label,${reverseField}` })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.label).toBe('Edited label');
		expect(readBack.body.data[reverseField]).toBe(parent);
	});

	test('denies a junction membership probe for a parent-update-only caller', async ({ api, scenario }) => {
		const { parent, junction } = scenario;

		const response = await request(api.url)
			.patch(`/items/${m2mParent}/${parent}`)
			.send({ tags: { update: [{ id: junction }] } })
			.set('Authorization', `Bearer ${m2mParentUpdateOnlyToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
	});

	test('updates related-tag content through the junction under narrow grants', async ({ api, scenario }) => {
		const { parent, junction, tag } = scenario;

		const response = await request(api.url)
			.patch(`/items/${m2mParent}/${parent}`)
			.send({ tags: { update: [{ id: junction, [tagField]: { id: tag, name: 'Renamed tag' } }] } })
			.set('Authorization', `Bearer ${junctionToken}`);

		expect(response.statusCode).toBe(200);

		const readBack = await request(api.url)
			.get(`/items/${tagCollection}/${tag}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.name).toBe('Renamed tag');
	});

	test('creates a new m2m parent and junctions when the reverse field is omitted', async ({ api }) => {
		const response = await request(api.url)
			.post(`/items/${m2mParent}`)
			.send({
				name: 'Omitted-reverse m2m parent',
				tags: { create: [{ label: 'Omitted junction', [tagField]: { name: 'Omitted tag' } }] },
			})
			.set('Authorization', `Bearer ${junctionToken}`);

		expect(response.statusCode).toBe(200);

		const parentId = response.body.data.id;

		const readBack = await request(api.url)
			.get(`/items/${m2mParent}/${parentId}`)
			.query({ fields: `name,tags.label,tags.${reverseField},tags.${tagField}.name` })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.name).toBe('Omitted-reverse m2m parent');
		expect(readBack.body.data.tags).toHaveLength(1);
		expect(readBack.body.data.tags[0].label).toBe('Omitted junction');
		expect(readBack.body.data.tags[0][reverseField]).toBe(parentId);
		expect(readBack.body.data.tags[0][tagField].name).toBe('Omitted tag');
	});

	test('links an existing tag to a new m2m parent when the reverse field is omitted', async ({ api, scenario }) => {
		const { existingTag } = scenario;

		const response = await request(api.url)
			.post(`/items/${m2mParent}`)
			.send({
				name: 'M2M selection parent',
				tags: { create: [{ label: 'Selection junction', [tagField]: { id: existingTag } }] },
			})
			.set('Authorization', `Bearer ${junctionToken}`);

		expect(response.statusCode).toBe(200);

		const parentId = response.body.data.id;

		const readBack = await request(api.url)
			.get(`/items/${m2mParent}/${parentId}`)
			.query({ fields: `tags.${reverseField},tags.${tagField}.id,tags.${tagField}.name` })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.tags).toHaveLength(1);
		expect(readBack.body.data.tags[0][reverseField]).toBe(parentId);
		expect(readBack.body.data.tags[0][tagField].id).toBe(existingTag);
		expect(readBack.body.data.tags[0][tagField].name).toBe('Existing selectable tag');

		const duplicates = await request(api.url)
			.get(`/items/${tagCollection}`)
			.query({ filter: JSON.stringify({ name: { _eq: 'Existing selectable tag' } }) })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(duplicates.statusCode).toBe(200);
		expect(duplicates.body.data).toHaveLength(1);
	});
});
