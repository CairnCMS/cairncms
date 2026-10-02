import { setupRequest } from '../../fixtures/request';
import { describe, expect, inject } from 'vitest';
import { apiTest, type Api } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection, CreateField, CreateFieldM2O, CreateFieldO2M } from '../../fixtures/schema';
import request from '../../fixtures/request';
import { randomUUID } from 'node:crypto';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const vendor = inject('integration').vendor;
const runId = randomUUID().slice(0, 8);
const parentCollection = `test_fr2b_parent_${runId}`;
const childCollection = `test_fr2b_child_${runId}`;
const authorCollection = `test_fr2b_author_${runId}`;
const metaToken = `Fr2bMeta_${runId}`;
const reparentToken = `Fr2bReparent_${runId}`;
const noReadToken = `Fr2bNoRead_${runId}`;
const nestedCreateToken = `Fr2bNestedCreate_${runId}`;
const parentUpdateOnlyToken = `Fr2bParentUpdateOnly_${runId}`;
const childReverseReaderToken = `Fr2bChildReverseReader_${runId}`;
const childRelationReaderToken = `Fr2bChildRelationReader_${runId}`;
const childRowReaderToken = `Fr2bChildRowReader_${runId}`;
const childUpdateReadExcludedToken = `Fr2bChildUpdateReadExcluded_${runId}`;
const childUpdateExcludedReadAllowedToken = `Fr2bChildUpdateExcludedReadAllowed_${runId}`;
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

async function seedParent(api: Api, name: string, childName: string | null) {
	const body: Record<string, any> = { name };
	if (childName !== null) body.children = { create: [{ name: childName }] };

	const created = await setupRequest(api.url)
		.post(`/items/${parentCollection}`)
		.send(body)
		.query({ fields: '*,children.*' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(created.statusCode).toBe(200);

	return created.body.data;
}

async function childRow(api: Api, childId: string) {
	const readBack = await request(api.url)
		.get(`/items/${childCollection}/${childId}`)
		.query({ fields: 'name,parent_id' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(readBack.statusCode).toBe(200);

	return readBack.body.data;
}

async function childRevisionCount(api: Api, childId: string) {
	const revisions = await request(api.url)
		.get('/revisions')
		.query({
			filter: JSON.stringify({
				_and: [{ collection: { _eq: childCollection } }, { item: { _eq: String(childId) } }],
			}),
			aggregate: JSON.stringify({ count: ['id'] }),
		})
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(revisions.statusCode).toBe(200);

	return Number(revisions.body.data[0].count.id);
}

async function latestChildRevisionDelta(api: Api, childId: string) {
	const revisions = await request(api.url)
		.get('/revisions')
		.query({
			filter: JSON.stringify({
				_and: [{ collection: { _eq: childCollection } }, { item: { _eq: String(childId) } }],
			}),
			sort: '-id',
			limit: 1,
			fields: 'delta',
		})
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(revisions.statusCode).toBe(200);

	return revisions.body.data[0].delta;
}

type Scenario = {
	author: string;
	metadataParent: string;
	metadataChild: string;
	noopParent: string;
	noopChild: string;
	reparentParent: string;
	reparentChild: string;
	denyReparentParent: string;
	foreignParent: string;
	foreignChild: string;
	noReadParent: string;
	noReadChild: string;
	m2oParent: string;
	o2mSelectableChild: string;
	linkedParent: string;
	linkedChild: string;
	multiLinkParent: string;
	multiLinkChildren: string[];
};

async function createRows(api: Api): Promise<Scenario> {
	const author = await setupRequest(api.url)
		.post(`/items/${authorCollection}`)
		.send({ name: 'Original author' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(author.statusCode).toBe(200);
	const authorId = author.body.data.id;
	const metadata = await seedParent(api, 'Metadata parent', 'Original child');
	const noop = await seedParent(api, 'No-op parent', 'No-op child');
	const reparentSource = await seedParent(api, 'Reparent source', 'Reparent child');
	const denyReparent = await seedParent(api, 'Deny reparent target', null);
	const foreign = await seedParent(api, 'Foreign parent', 'Foreign child');
	const noRead = await seedParent(api, 'No-read parent', 'No-read child');
	const o2mSelectable = await seedParent(api, 'O2M selection source', 'Existing selectable child');
	const linked = await seedParent(api, 'Linked parent', 'Linked target child');

	const multiLink = await setupRequest(api.url)
		.post(`/items/${parentCollection}`)
		.send({
			name: 'Multi link parent',
			children: {
				create: [{ name: 'Multi link child A' }, { name: 'Multi link child B' }, { name: 'Multi link child C' }],
			},
		})
		.query({ fields: '*,children.*' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(multiLink.statusCode).toBe(200);

	const m2oParent = await setupRequest(api.url)
		.post(`/items/${parentCollection}`)
		.send({ name: 'M2O parent', author: authorId })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(m2oParent.statusCode).toBe(200);
	return {
		author: authorId,
		metadataParent: metadata.id,
		metadataChild: metadata.children[0].id,
		noopParent: noop.id,
		noopChild: noop.children[0].id,
		reparentParent: reparentSource.id,
		reparentChild: reparentSource.children[0].id,
		denyReparentParent: denyReparent.id,
		foreignParent: foreign.id,
		foreignChild: foreign.children[0].id,
		noReadParent: noRead.id,
		noReadChild: noRead.children[0].id,
		m2oParent: m2oParent.body.data.id,
		o2mSelectableChild: o2mSelectable.children[0].id,
		linkedParent: linked.id,
		linkedChild: linked.children[0].id,
		multiLinkParent: multiLink.body.data.id,
		multiLinkChildren: multiLink.body.data.children.map((child: any) => child.id),
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

					async function createCollection(api: Api, name: string) {
						const collection = await CreateCollection(api, { collection: name });

						track(async () => {
							await request(api.url).delete(`/collections/${name}`).set('Authorization', `Bearer ${api.adminToken}`);
						});

						expect(collection.collection).toBe(name);
					}

					try {
						await createCollection(api, parentCollection);
						await createCollection(api, childCollection);
						await createCollection(api, authorCollection);

						const nameFields = await Promise.all([
							CreateField(api, { collection: parentCollection, field: 'name', type: 'string' }),
							CreateField(api, { collection: childCollection, field: 'name', type: 'string' }),
							CreateField(api, { collection: authorCollection, field: 'name', type: 'string' }),
						]);

						for (const nameField of nameFields) {
							expect(nameField.field).toBe('name');
						}

						const noteField = await CreateField(api, {
							collection: childCollection,
							field: 'note',
							type: 'string',
						});

						expect(noteField.field).toBe('note');

						const o2m = await CreateFieldO2M(api, {
							collection: parentCollection,
							field: 'children',
							otherCollection: childCollection,
							otherField: 'parent_id',
							primaryKeyType: 'integer',
						});

						expect(o2m.field.field).toBe('children');
						expect(o2m.relation.field).toBe('parent_id');

						const m2o = await CreateFieldM2O(api, {
							collection: parentCollection,
							field: 'author',
							otherCollection: authorCollection,
							primaryKeyType: 'integer',
						});

						expect(m2o.field.field).toBe('author');
						expect(m2o.relation.related_collection).toBe(authorCollection);

						const metaRole = await createRoleUser(
							api,
							`FR2b Metadata ${runId}`,
							metaToken,
							`fr2b-meta-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, metaRole, parentCollection, 'read', ['*']);
						await grant(api, metaRole, parentCollection, 'update', ['*']);
						await grant(api, metaRole, childCollection, 'update', ['name'], { name: { _neq: 'Foreign child' } });
						await grant(api, metaRole, authorCollection, 'update', ['name']);

						const reparentRole = await createRoleUser(
							api,
							`FR2b Reparent ${runId}`,
							reparentToken,
							`fr2b-reparent-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, reparentRole, parentCollection, 'read', ['*']);
						await grant(api, reparentRole, parentCollection, 'update', ['*']);
						await grant(api, reparentRole, childCollection, 'update', ['name', 'parent_id']);

						const noReadRole = await createRoleUser(
							api,
							`FR2b No Read ${runId}`,
							noReadToken,
							`fr2b-noread-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, noReadRole, parentCollection, 'update', ['*']);
						await grant(api, noReadRole, childCollection, 'update', ['name']);

						await grant(
							api,
							noReadRole,
							childCollection,
							'create',
							['*'],
							{},
							{ note: 'Preset note' },
							{ parent_id: { _submitted: true } }
						);

						const nestedCreateRole = await createRoleUser(
							api,
							`FR2b Nested Create ${runId}`,
							nestedCreateToken,
							`fr2b-nestedcreate-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, nestedCreateRole, parentCollection, 'read', ['*']);
						await grant(api, nestedCreateRole, parentCollection, 'create', ['*']);
						await grant(api, nestedCreateRole, childCollection, 'create', ['name', 'parent_id']);
						await grant(api, nestedCreateRole, childCollection, 'update', ['name', 'parent_id']);

						const parentUpdateOnlyRole = await createRoleUser(
							api,
							`FR2b Parent Update Only ${runId}`,
							parentUpdateOnlyToken,
							`fr2b-parentupdateonly-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, parentUpdateOnlyRole, parentCollection, 'update', ['*']);

						const childReverseReaderRole = await createRoleUser(
							api,
							`FR2b Child Reverse Reader ${runId}`,
							childReverseReaderToken,
							`fr2b-childreversereader-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, childReverseReaderRole, parentCollection, 'update', ['*']);
						await grant(api, childReverseReaderRole, childCollection, 'read', ['*']);

						const childRelationReaderRole = await createRoleUser(
							api,
							`FR2b Child Relation Reader ${runId}`,
							childRelationReaderToken,
							`fr2b-childrelationreader-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, childRelationReaderRole, parentCollection, 'read', ['*']);
						await grant(api, childRelationReaderRole, parentCollection, 'update', ['*']);
						await grant(api, childRelationReaderRole, childCollection, 'read', ['id', 'name']);

						const childRowReaderRole = await createRoleUser(
							api,
							`FR2b Child Row Reader ${runId}`,
							childRowReaderToken,
							`fr2b-childrowreader-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, childRowReaderRole, parentCollection, 'update', ['*']);
						await grant(api, childRowReaderRole, childCollection, 'read', ['id', 'name']);

						const childUpdateReadExcludedRole = await createRoleUser(
							api,
							`FR2b Child Update Read Excluded ${runId}`,
							childUpdateReadExcludedToken,
							`fr2b-childupdatereadexcluded-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, childUpdateReadExcludedRole, parentCollection, 'read', ['*']);
						await grant(api, childUpdateReadExcludedRole, parentCollection, 'update', ['*']);

						await grant(api, childUpdateReadExcludedRole, childCollection, 'update', ['name'], {
							name: { _neq: 'Linked target child' },
						});

						await grant(api, childUpdateReadExcludedRole, childCollection, 'read', ['*'], {
							name: { _neq: 'Linked target child' },
						});

						const childUpdateExcludedReadAllowedRole = await createRoleUser(
							api,
							`FR2b Child Update Excluded Read Allowed ${runId}`,
							childUpdateExcludedReadAllowedToken,
							`fr2b-childupdateexcludedreadallowed-${runId}-${vendor}@tests.com`,
							(fn) => track(fn)
						);

						await grant(api, childUpdateExcludedReadAllowedRole, parentCollection, 'read', ['*']);
						await grant(api, childUpdateExcludedReadAllowedRole, parentCollection, 'update', ['*']);

						await grant(api, childUpdateExcludedReadAllowedRole, childCollection, 'update', ['name'], {
							name: { _neq: 'Linked target child' },
						});

						await grant(api, childUpdateExcludedReadAllowedRole, childCollection, 'read', ['*']);

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
			for (const table of [childCollection, parentCollection, authorCollection]) await api.database(table).delete();
			await api.database('directus_revisions').delete();
			await api.database('directus_activity').delete();
			await use(await createRows(api));
		},
		{ auto: true },
	],
});

describe('Nested write selector and link separation', () => {
	test('updates a linked o2m child (object-array) under a grant excluding the reverse field', async ({
		api,
		scenario,
	}) => {
		const { metadataParent, metadataChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${metadataParent}`)
			.send({ children: [{ id: metadataChild, name: 'Renamed child' }] })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(200);

		const row = await childRow(api, metadataChild);
		expect(row.name).toBe('Renamed child');
		expect(row.parent_id).toBe(metadataParent);

		const delta = await latestChildRevisionDelta(api, metadataChild);
		expect(delta.name).toBe('Renamed child');
		expect(delta.parent_id).toBeUndefined();
	});

	test('updates a linked o2m child (alterations) under a grant excluding the reverse field', async ({
		api,
		scenario,
	}) => {
		const { reparentParent, reparentChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${reparentParent}`)
			.send({ children: { update: [{ id: reparentChild, name: 'Edited child' }] } })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(200);

		const row = await childRow(api, reparentChild);
		expect(row.name).toBe('Edited child');
		expect(row.parent_id).toBe(reparentParent);
	});

	test('treats a key-only already-linked child as a no-op with no new revision', async ({ api, scenario }) => {
		const { noopParent, noopChild } = scenario;

		const before = await childRevisionCount(api, noopChild);

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${noopParent}`)
			.send({ children: [{ id: noopChild }] })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(200);

		const after = await childRevisionCount(api, noopChild);
		expect(after).toBe(before);

		const row = await childRow(api, noopChild);
		expect(row.name).toBe('No-op child');
		expect(row.parent_id).toBe(noopParent);
	});

	test('rolls back the whole mutation when a nested reparent is denied', async ({ api, scenario }) => {
		const { denyReparentParent, metadataChild } = scenario;

		const parentBefore = await request(api.url)
			.get(`/items/${parentCollection}/${denyReparentParent}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(parentBefore.statusCode).toBe(200);

		const childBefore = await childRow(api, metadataChild);

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${denyReparentParent}`)
			.send({ name: 'Renamed parent', children: { update: [{ id: metadataChild, name: 'Should not move' }] } })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');

		const parentAfter = await request(api.url)
			.get(`/items/${parentCollection}/${denyReparentParent}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(parentAfter.body.data.name).toBe(parentBefore.body.data.name);

		const childAfter = await childRow(api, metadataChild);
		expect(childAfter).toEqual(childBefore);
	});

	test('allows a reparent when the reverse field is granted', async ({ api, scenario }) => {
		const { denyReparentParent, reparentChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${denyReparentParent}`)
			.send({ children: { update: [{ id: reparentChild, name: 'Moved child' }] } })
			.set('Authorization', `Bearer ${reparentToken}`);

		expect(response.statusCode).toBe(200);

		const row = await childRow(api, reparentChild);
		expect(row.parent_id).toBe(denyReparentParent);
		expect(row.name).toBe('Moved child');
	});

	test('rejects a nested update targeting a permission-filtered foreign child', async ({ api, scenario }) => {
		const { foreignParent, foreignChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${foreignParent}`)
			.send({ children: { update: [{ id: foreignChild, name: 'Hijacked' }] } })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');

		const row = await childRow(api, foreignChild);
		expect(row.name).toBe('Foreign child');
	});

	test('persists a nested update for a caller without read access', async ({ api, scenario }) => {
		const { noReadParent, noReadChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${noReadParent}`)
			.send({ children: { update: [{ id: noReadChild, name: 'Written without read' }] } })
			.set('Authorization', `Bearer ${noReadToken}`);

		expect(response.statusCode).toBe(204);

		const row = await childRow(api, noReadChild);
		expect(row.name).toBe('Written without read');
		expect(row.parent_id).toBe(noReadParent);
	});

	test('creates a nested child applying a preset and the required association', async ({ api, scenario }) => {
		const { noReadParent } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${noReadParent}`)
			.send({ children: { create: [{ name: 'Nested created child' }] } })
			.set('Authorization', `Bearer ${noReadToken}`);

		expect(response.statusCode).toBe(204);

		const readBack = await request(api.url)
			.get(`/items/${parentCollection}/${noReadParent}`)
			.query({ fields: 'children.name,children.note,children.parent_id' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		const created = readBack.body.data.children.find((child: any) => child.name === 'Nested created child');
		expect(created).toBeDefined();
		expect(created.parent_id).toBe(noReadParent);
		expect(created.note).toBe('Preset note');
	});

	test('creates a new parent and nested o2m children when the reverse field is omitted', async ({ api }) => {
		const response = await request(api.url)
			.post(`/items/${parentCollection}`)
			.send({
				name: 'Omitted-reverse parent',
				children: { create: [{ name: 'Omitted child A' }, { name: 'Omitted child B' }] },
			})
			.set('Authorization', `Bearer ${nestedCreateToken}`);

		expect(response.statusCode).toBe(200);

		const parentId = response.body.data.id;

		const readBack = await request(api.url)
			.get(`/items/${parentCollection}/${parentId}`)
			.query({ fields: 'name,children.name,children.parent_id' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.name).toBe('Omitted-reverse parent');

		const children = readBack.body.data.children;
		expect(children.map((child: any) => child.name).sort()).toEqual(['Omitted child A', 'Omitted child B']);

		for (const child of children) {
			expect(child.parent_id).toBe(parentId);
		}
	});

	test('links an existing o2m child to a new parent when the reverse field is omitted', async ({ api, scenario }) => {
		const { o2mSelectableChild } = scenario;

		const response = await request(api.url)
			.post(`/items/${parentCollection}`)
			.send({ name: 'O2M selection parent', children: { update: [{ id: o2mSelectableChild }] } })
			.set('Authorization', `Bearer ${nestedCreateToken}`);

		expect(response.statusCode).toBe(200);

		const parentId = response.body.data.id;

		const readBack = await request(api.url)
			.get(`/items/${parentCollection}/${parentId}`)
			.query({ fields: 'children.id,children.name,children.parent_id' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.children).toHaveLength(1);
		expect(readBack.body.data.children[0].id).toBe(o2mSelectableChild);
		expect(readBack.body.data.children[0].name).toBe('Existing selectable child');
		expect(readBack.body.data.children[0].parent_id).toBe(parentId);

		const duplicates = await request(api.url)
			.get(`/items/${childCollection}`)
			.query({ filter: JSON.stringify({ name: { _eq: 'Existing selectable child' } }) })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(duplicates.statusCode).toBe(200);
		expect(duplicates.body.data).toHaveLength(1);
	});

	test('copies children onto a new parent without altering the source parent relationships', async ({ api }) => {
		const source = await seedParent(api, 'Copy source parent', 'Copy source child');
		const sourceChildId = source.children[0].id;

		const response = await request(api.url)
			.post(`/items/${parentCollection}`)
			.send({ name: 'Copied parent', children: { create: [{ name: 'Copied child' }] } })
			.query({ fields: '*,children.*' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(response.statusCode).toBe(200);

		const copyId = response.body.data.id;
		expect(response.body.data.children).toHaveLength(1);

		const copiedChild = response.body.data.children[0];
		expect(copiedChild.name).toBe('Copied child');
		expect(copiedChild.parent_id).toBe(copyId);
		expect(copiedChild.id).not.toBe(sourceChildId);

		const sourceChild = await childRow(api, sourceChildId);
		expect(sourceChild.name).toBe('Copy source child');
		expect(sourceChild.parent_id).toBe(source.id);
	});

	test('rejects a direct child create that omits the required association', async ({ api }) => {
		const response = await request(api.url)
			.post(`/items/${childCollection}`)
			.send({ name: 'Orphan child' })
			.set('Authorization', `Bearer ${noReadToken}`);

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('FAILED_VALIDATION');

		const readBack = await request(api.url)
			.get(`/items/${childCollection}`)
			.query({ filter: JSON.stringify({ name: { _eq: 'Orphan child' } }) })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.body.data).toHaveLength(0);
	});

	test('updates m2o content under a grant that excludes the related key', async ({ api, scenario }) => {
		const { m2oParent, author } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${m2oParent}`)
			.send({ author: { id: author, name: 'Renamed author' } })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(200);

		const readBack = await request(api.url)
			.get(`/items/${authorCollection}/${author}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${api.adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.name).toBe('Renamed author');
	});

	test('establishes the read-route roles read only what their names claim', async ({ api, scenario }) => {
		const { linkedParent, linkedChild } = scenario;

		const reverseRead = await request(api.url)
			.get(`/items/${childCollection}/${linkedChild}`)
			.query({ fields: 'id,parent_id' })
			.set('Authorization', `Bearer ${childReverseReaderToken}`);

		expect(reverseRead.statusCode).toBe(200);
		expect(reverseRead.body.data.parent_id).toBe(linkedParent);

		const relationChildRead = await request(api.url)
			.get(`/items/${childCollection}/${linkedChild}`)
			.query({ fields: 'id,parent_id' })
			.set('Authorization', `Bearer ${childRelationReaderToken}`);

		expect(relationChildRead.statusCode).toBe(403);

		const relationParentRead = await request(api.url)
			.get(`/items/${parentCollection}/${linkedParent}`)
			.query({ fields: 'id,children.id' })
			.set('Authorization', `Bearer ${childRelationReaderToken}`);

		expect(relationParentRead.statusCode).toBe(200);
		expect(relationParentRead.body.data.children.map((child: any) => child.id)).toContain(linkedChild);

		const rowReaderParent = await request(api.url)
			.get(`/items/${parentCollection}/${linkedParent}`)
			.query({ fields: 'id,children.id' })
			.set('Authorization', `Bearer ${childRowReaderToken}`);

		expect(rowReaderParent.statusCode).toBe(403);
	});

	test('denies a parent-update-only caller probing o2m membership across every form', async ({ api, scenario }) => {
		const { linkedParent, linkedChild, multiLinkChildren } = scenario;
		const probes = [linkedChild, multiLinkChildren[0]!, 999000001];

		for (const key of probes) {
			const scalar = await request(api.url)
				.patch(`/items/${parentCollection}/${linkedParent}`)
				.send({ children: [key] })
				.set('Authorization', `Bearer ${parentUpdateOnlyToken}`);

			expect(scalar.statusCode).toBe(403);
			expect(scalar.body.errors[0].extensions.code).toBe('FORBIDDEN');

			const objectArray = await request(api.url)
				.patch(`/items/${parentCollection}/${linkedParent}`)
				.send({ children: [{ id: key }] })
				.set('Authorization', `Bearer ${parentUpdateOnlyToken}`);

			expect(objectArray.statusCode).toBe(403);
			expect(objectArray.body.errors[0].extensions.code).toBe('FORBIDDEN');

			const detailed = await request(api.url)
				.patch(`/items/${parentCollection}/${linkedParent}`)
				.send({ children: { update: [{ id: key }] } })
				.set('Authorization', `Bearer ${parentUpdateOnlyToken}`);

			expect(detailed.statusCode).toBe(403);
			expect(detailed.body.errors[0].extensions.code).toBe('FORBIDDEN');
		}

		const linkedRow = await childRow(api, linkedChild);
		expect(linkedRow.name).toBe('Linked target child');
		expect(linkedRow.parent_id).toBe(linkedParent);
	});

	test('denies a per-membership detailed probe amid siblings on a multi-child parent', async ({ api, scenario }) => {
		const { multiLinkParent, multiLinkChildren } = scenario;
		const target = multiLinkChildren[0]!;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${multiLinkParent}`)
			.send({ children: { update: [{ id: target }] } })
			.set('Authorization', `Bearer ${parentUpdateOnlyToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');

		for (const childId of multiLinkChildren) {
			const row = await childRow(api, childId);
			expect(row.parent_id).toBe(multiLinkParent);
		}
	});

	test('creates no child revision when a denied membership probe is rejected', async ({ api, scenario }) => {
		const { linkedParent, linkedChild } = scenario;

		const before = await childRevisionCount(api, linkedChild);

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${linkedParent}`)
			.send({ children: { update: [{ id: linkedChild }] } })
			.set('Authorization', `Bearer ${parentUpdateOnlyToken}`);

		expect(response.statusCode).toBe(403);

		const after = await childRevisionCount(api, linkedChild);
		expect(after).toBe(before);
	});

	test('preserves the key-only no-op for an update-without-read caller', async ({ api, scenario }) => {
		const { linkedParent, linkedChild } = scenario;

		const before = await childRevisionCount(api, linkedChild);

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${linkedParent}`)
			.send({ children: { update: [{ id: linkedChild }] } })
			.set('Authorization', `Bearer ${noReadToken}`);

		expect(response.statusCode).toBe(204);

		const after = await childRevisionCount(api, linkedChild);
		expect(after).toBe(before);

		const row = await childRow(api, linkedChild);
		expect(row.parent_id).toBe(linkedParent);
	});

	test('allows the key-only no-op when the caller can read the child reverse field', async ({ api, scenario }) => {
		const { linkedParent, linkedChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${linkedParent}`)
			.send({ children: { update: [{ id: linkedChild }] } })
			.set('Authorization', `Bearer ${childReverseReaderToken}`);

		expect(response.statusCode).toBe(204);

		const row = await childRow(api, linkedChild);
		expect(row.parent_id).toBe(linkedParent);
	});

	test('allows the key-only no-op when the caller can read the child id through the parent relation', async ({
		api,
		scenario,
	}) => {
		const { linkedParent, linkedChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${linkedParent}`)
			.send({ children: { update: [{ id: linkedChild }] } })
			.set('Authorization', `Bearer ${childRelationReaderToken}`);

		expect(response.statusCode).toBe(200);

		const row = await childRow(api, linkedChild);
		expect(row.parent_id).toBe(linkedParent);
	});

	test('denies the key-only no-op when the child row is readable but no membership route is', async ({
		api,
		scenario,
	}) => {
		const { linkedParent, linkedChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${linkedParent}`)
			.send({ children: { update: [{ id: linkedChild }] } })
			.set('Authorization', `Bearer ${childRowReaderToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
	});

	test('denies the key-only no-op when update and read both exclude the child', async ({ api, scenario }) => {
		const { linkedParent, linkedChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${linkedParent}`)
			.send({ children: { update: [{ id: linkedChild }] } })
			.set('Authorization', `Bearer ${childUpdateReadExcludedToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
	});

	test('allows the key-only no-op when child update is excluded but membership read is granted', async ({
		api,
		scenario,
	}) => {
		const { linkedParent, linkedChild } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${linkedParent}`)
			.send({ children: { update: [{ id: linkedChild }] } })
			.set('Authorization', `Bearer ${childUpdateExcludedReadAllowedToken}`);

		expect(response.statusCode).toBe(200);

		const row = await childRow(api, linkedChild);
		expect(row.parent_id).toBe(linkedParent);
	});

	test('preserves a full-list scalar array round-trip without unlinking siblings', async ({ api, scenario }) => {
		const { multiLinkParent, multiLinkChildren } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${multiLinkParent}`)
			.send({ children: multiLinkChildren })
			.set('Authorization', `Bearer ${childReverseReaderToken}`);

		expect(response.statusCode).toBe(204);

		for (const childId of multiLinkChildren) {
			const row = await childRow(api, childId);
			expect(row.parent_id).toBe(multiLinkParent);
		}
	});

	test('preserves a full-list object-array round-trip without unlinking siblings', async ({ api, scenario }) => {
		const { multiLinkParent, multiLinkChildren } = scenario;

		const response = await request(api.url)
			.patch(`/items/${parentCollection}/${multiLinkParent}`)
			.send({ children: multiLinkChildren.map((id) => ({ id })) })
			.set('Authorization', `Bearer ${childReverseReaderToken}`);

		expect(response.statusCode).toBe(204);

		for (const childId of multiLinkChildren) {
			const row = await childRow(api, childId);
			expect(row.parent_id).toBe(multiLinkParent);
		}
	});
});
