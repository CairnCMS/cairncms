import { setupRequest } from '../../fixtures/request';
import { describe, expect, inject } from 'vitest';
import { apiTest, type Api } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection, CreateField, CreateFieldM2A } from '../../fixtures/schema';
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

const m2aParent = `test_fr2b_m2a_parent_${runId}`;
const blockCollection = `test_fr2b_block_${runId}`;
const junctionM2A = `test_fr2b_blockjunc_${runId}`;
const reverseFieldM2A = `${junctionM2A}_id`;
const m2aToken = `Fr2bM2aAllow_${runId}`;
const denyToken = `Fr2bM2aDeny_${runId}`;
const discDenyToken = `Fr2bM2aDiscDeny_${runId}`;
const m2aCreateToken = `Fr2bM2aCreate_${runId}`;
const m2aParentUpdateOnlyToken = `Fr2bM2aParentUpdateOnly_${runId}`;

async function adminRead(api: Api, collection: string, key: string, fields: string) {
	const response = await request(api.url)
		.get(`/items/${collection}/${key}`)
		.query({ fields })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);

	return response.body.data;
}

type Scenario = { parent: string; block: string; junction: string; existingBlock: string };

async function createRows(api: Api): Promise<Scenario> {
	const parent = await setupRequest(api.url)
		.post(`/items/${m2aParent}`)
		.send({ name: 'M2A parent' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(parent.statusCode).toBe(200);
	const parentId = parent.body.data.id;

	const block = await setupRequest(api.url)
		.post(`/items/${blockCollection}`)
		.send({ name: 'Block A', collection: 'own-original' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(block.statusCode).toBe(200);
	const blockId = block.body.data.id;

	const junction = await setupRequest(api.url)
		.post(`/items/${junctionM2A}`)
		.send({ [reverseFieldM2A]: parentId, collection: blockCollection, item: String(blockId) })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(junction.statusCode).toBe(200);

	const existingBlock = await setupRequest(api.url)
		.post(`/items/${blockCollection}`)
		.send({ name: 'Existing selectable block', collection: 'own-existing' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(existingBlock.statusCode).toBe(200);
	return {
		parent: parentId,
		block: blockId,
		junction: junction.body.data.id,
		existingBlock: existingBlock.body.data.id,
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

					async function makeRoleUser(
						api: Api,
						name: string,
						token: string,
						junctionUpdateFields: string[],
						blockUpdateFields: string[]
					) {
						const roleId = await createRoleUser(api, name, token, `${token}-${vendor}@tests.com`, track);

						for (const [collection, action, fields] of [
							[m2aParent, 'read', ['*']],
							[m2aParent, 'update', ['*']],
							// The parent link must not be rewritten.
							[junctionM2A, 'update', junctionUpdateFields],
							[blockCollection, 'update', blockUpdateFields],
						] as const) {
							await grant(api, roleId, collection, action, fields);
						}
					}

					try {
						const parentColl = await CreateCollection(api, { collection: m2aParent });

						track(async () => {
							await request(api.url)
								.delete(`/collections/${m2aParent}`)
								.set('Authorization', `Bearer ${api.adminToken}`);
						});

						expect(parentColl.collection).toBe(m2aParent);
						const blockColl = await CreateCollection(api, { collection: blockCollection });

						track(async () => {
							await request(api.url)
								.delete(`/collections/${blockCollection}`)
								.set('Authorization', `Bearer ${api.adminToken}`);
						});

						expect(blockColl.collection).toBe(blockCollection);
						await CreateField(api, { collection: m2aParent, field: 'name', type: 'string' });
						await CreateField(api, { collection: blockCollection, field: 'name', type: 'string' });
						await CreateField(api, { collection: blockCollection, field: 'collection', type: 'string' });

						const m2a = await CreateFieldM2A(api, {
							collection: m2aParent,
							field: 'blocks',
							relatedCollections: [blockCollection],
							junctionCollection: junctionM2A,
							primaryKeyType: 'integer',
						});

						track(async () => {
							await request(api.url)
								.delete(`/collections/${junctionM2A}`)
								.set('Authorization', `Bearer ${api.adminToken}`);
						});

						expect(m2a.junctionCollection).toBeDefined();

						await makeRoleUser(
							api,
							`FR2b M2A Allow ${runId}`,
							m2aToken,
							['item', 'collection'],
							['name', 'collection']
						);

						await makeRoleUser(api, `FR2b M2A Deny ${runId}`, denyToken, ['item', 'collection'], ['collection']);
						await makeRoleUser(api, `FR2b M2A Disc Deny ${runId}`, discDenyToken, ['item'], ['name', 'collection']);

						const m2aCreateRoleId = await createRoleUser(
							api,
							`FR2b M2A Create ${runId}`,
							m2aCreateToken,
							`${m2aCreateToken}-${vendor}@tests.com`,
							track
						);

						for (const [collection, action, fields] of [
							[m2aParent, 'read', ['*']],
							[m2aParent, 'create', ['*']],
							[junctionM2A, 'create', ['collection', 'item', reverseFieldM2A]],
						] as const) {
							await grant(api, m2aCreateRoleId, collection, action, fields);
						}

						const m2aParentUpdateOnlyRoleId = await createRoleUser(
							api,
							`FR2b M2A Parent Update Only ${runId}`,
							m2aParentUpdateOnlyToken,
							`${m2aParentUpdateOnlyToken}-${vendor}@tests.com`,
							track
						);

						await grant(api, m2aParentUpdateOnlyRoleId, m2aParent, 'update', ['*']);

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
			for (const table of [junctionM2A, m2aParent, blockCollection]) await api.database(table).delete();
			await api.database('directus_revisions').delete();
			await api.database('directus_activity').delete();
			await use(await createRows(api));
		},
		{ auto: true },
	],
});

describe('Nested any (m2a) write selector and link separation', () => {
	test('updates a2o related content, including a same-named field, and preserves the discriminator', async ({
		api,
		scenario,
	}) => {
		const { parent, block, junction } = scenario;

		const response = await request(api.url)
			.patch(`/items/${m2aParent}/${parent}`)
			.send({
				blocks: {
					update: [
						{
							id: junction,
							collection: blockCollection,
							item: { id: block, name: 'Block updated', collection: 'own-updated' },
						},
					],
				},
			})
			.set('Authorization', `Bearer ${m2aToken}`);

		expect(response.statusCode).toBe(200);

		const blockBack = await request(api.url)
			.get(`/items/${blockCollection}/${block}`)
			.query({ fields: 'name,collection' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(blockBack.statusCode).toBe(200);
		expect(blockBack.body.data.name).toBe('Block updated');
		expect(blockBack.body.data.collection).toBe('own-updated');

		const junctionBack = await request(api.url)
			.get(`/items/${junctionM2A}/${junction}`)
			.query({ fields: `collection,${reverseFieldM2A}` })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(junctionBack.body.data.collection).toBe(blockCollection);
		expect(junctionBack.body.data[reverseFieldM2A]).toBe(parent);
	});

	test('rolls back the whole mutation when a2o related content is denied', async ({ api, scenario }) => {
		const { parent, block, junction } = scenario;

		const parentBefore = await adminRead(api, m2aParent, parent, 'name');
		const blockBefore = await adminRead(api, blockCollection, block, 'name,collection');
		const junctionBefore = await adminRead(api, junctionM2A, junction, `collection,${reverseFieldM2A}`);

		const response = await request(api.url)
			.patch(`/items/${m2aParent}/${parent}`)
			.send({
				name: 'Parent should roll back',
				blocks: {
					update: [{ id: junction, collection: blockCollection, item: { id: block, name: 'Should not persist' } }],
				},
			})
			.set('Authorization', `Bearer ${denyToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');

		expect(await adminRead(api, m2aParent, parent, 'name')).toEqual(parentBefore);
		expect(await adminRead(api, blockCollection, block, 'name,collection')).toEqual(blockBefore);
		expect(await adminRead(api, junctionM2A, junction, `collection,${reverseFieldM2A}`)).toEqual(junctionBefore);
	});

	test('rejects an a2o discriminator write that is not granted and leaves rows unchanged', async ({
		api,
		scenario,
	}) => {
		const { parent, block, junction } = scenario;

		const blockBefore = await adminRead(api, blockCollection, block, 'name,collection');
		const junctionBefore = await adminRead(api, junctionM2A, junction, `collection,${reverseFieldM2A}`);

		const response = await request(api.url)
			.patch(`/items/${m2aParent}/${parent}`)
			.send({
				blocks: {
					update: [
						{ id: junction, collection: blockCollection, item: { id: block, name: 'Blocked by discriminator' } },
					],
				},
			})
			.set('Authorization', `Bearer ${discDenyToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');

		expect(await adminRead(api, blockCollection, block, 'name,collection')).toEqual(blockBefore);
		expect(await adminRead(api, junctionM2A, junction, `collection,${reverseFieldM2A}`)).toEqual(junctionBefore);
	});

	test('links an existing m2a item to a new parent when the reverse field is omitted', async ({ api, scenario }) => {
		const { existingBlock } = scenario;

		const response = await request(api.url)
			.post(`/items/${m2aParent}`)
			.send({
				name: 'M2A selection parent',
				blocks: { create: [{ collection: blockCollection, item: { id: existingBlock } }] },
			})
			.set('Authorization', `Bearer ${m2aCreateToken}`);

		expect(response.statusCode).toBe(200);

		const parentId = response.body.data.id;

		const readBack = await request(api.url)
			.get(`/items/${m2aParent}/${parentId}`)
			.query({ fields: `blocks.${reverseFieldM2A},blocks.collection,blocks.item` })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.blocks).toHaveLength(1);
		expect(readBack.body.data.blocks[0][reverseFieldM2A]).toBe(parentId);
		expect(readBack.body.data.blocks[0].collection).toBe(blockCollection);
		expect(String(readBack.body.data.blocks[0].item)).toBe(String(existingBlock));

		const duplicates = await request(api.url)
			.get(`/items/${blockCollection}`)
			.query({ filter: JSON.stringify({ name: { _eq: 'Existing selectable block' } }) })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(duplicates.statusCode).toBe(200);
		expect(duplicates.body.data).toHaveLength(1);
	});

	test('denies an m2a junction membership probe for a parent-update-only caller', async ({ api, scenario }) => {
		const { parent, junction } = scenario;

		const response = await request(api.url)
			.patch(`/items/${m2aParent}/${parent}`)
			.send({ blocks: { update: [{ id: junction }] } })
			.set('Authorization', `Bearer ${m2aParentUpdateOnlyToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
	});
});
