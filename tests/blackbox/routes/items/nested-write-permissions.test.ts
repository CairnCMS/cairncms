import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

// TESTS_FLOW has admin access and would bypass the field restrictions under test.

const runId = randomUUID().slice(0, 8);
const parentCollection = `test_fr2b_parent_${runId}`;
const childCollection = `test_fr2b_child_${runId}`;
const authorCollection = `test_fr2b_author_${runId}`;

const adminToken = common.USER.ADMIN.TOKEN;
const metaToken = `Fr2bMeta_${runId}`;
const reparentToken = `Fr2bReparent_${runId}`;
const noReadToken = `Fr2bNoRead_${runId}`;

describe('Nested write selector and link separation', () => {
	const cleanups: Record<string, (() => Promise<void>)[]> = {};

	const ids = {} as Record<
		string,
		{
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
		}
	>;

	function track(vendor: string, fn: () => Promise<void>) {
		(cleanups[vendor] ??= []).push(fn);
	}

	async function createRole(vendor: string, name: string) {
		const role = await request(getUrl(vendor))
			.post('/roles')
			.send({ name, admin_access: false, app_access: true })
			.set('Authorization', `Bearer ${adminToken}`);

		const roleId = role.body?.data?.id as string | undefined;

		if (roleId) {
			track(vendor, async () => {
				await request(getUrl(vendor)).delete(`/roles/${roleId}`).set('Authorization', `Bearer ${adminToken}`);
			});
		}

		expect(role.statusCode).toBe(200);

		return roleId!;
	}

	async function createUser(vendor: string, roleId: string, token: string, email: string) {
		const user = await request(getUrl(vendor))
			.post('/users')
			.send({ email, password: 'Fr2bPassword', token, role: roleId, status: 'active' })
			.set('Authorization', `Bearer ${adminToken}`);

		const userId = user.body?.data?.id as string | undefined;

		if (userId) {
			track(vendor, async () => {
				await request(getUrl(vendor)).delete(`/users/${userId}`).set('Authorization', `Bearer ${adminToken}`);
			});
		}

		expect(user.statusCode).toBe(200);

		return userId!;
	}

	async function grant(
		vendor: string,
		roleId: string,
		collection: string,
		action: string,
		fields: string[],
		permissions: Record<string, any> = {},
		presets: Record<string, any> | null = null,
		validation: Record<string, any> | null = null
	) {
		const response = await request(getUrl(vendor))
			.post('/permissions')
			.send({ role: roleId, collection, action, fields, permissions, presets, validation })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(response.statusCode).toBe(200);
	}

	async function createCollection(vendor: string, name: string) {
		const collection = await common.CreateCollection(vendor, { collection: name });

		track(vendor, async () => {
			await request(getUrl(vendor)).delete(`/collections/${name}`).set('Authorization', `Bearer ${adminToken}`);
		});

		expect(collection.collection).toBe(name);
	}

	async function seedParent(vendor: string, name: string, childName: string | null) {
		const body: Record<string, any> = { name };
		if (childName !== null) body.children = { create: [{ name: childName }] };

		const created = await request(getUrl(vendor))
			.post(`/items/${parentCollection}`)
			.send(body)
			.query({ fields: '*,children.*' })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(created.statusCode).toBe(200);

		return created.body.data;
	}

	async function childRow(vendor: string, childId: string) {
		const readBack = await request(getUrl(vendor))
			.get(`/items/${childCollection}/${childId}`)
			.query({ fields: 'name,parent_id' })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(readBack.statusCode).toBe(200);

		return readBack.body.data;
	}

	async function childRevisionCount(vendor: string, childId: string) {
		const revisions = await request(getUrl(vendor))
			.get('/revisions')
			.query({
				filter: JSON.stringify({
					_and: [{ collection: { _eq: childCollection } }, { item: { _eq: String(childId) } }],
				}),
				aggregate: JSON.stringify({ count: ['id'] }),
			})
			.set('Authorization', `Bearer ${adminToken}`);

		expect(revisions.statusCode).toBe(200);

		return Number(revisions.body.data[0].count.id);
	}

	async function latestChildRevisionDelta(vendor: string, childId: string) {
		const revisions = await request(getUrl(vendor))
			.get('/revisions')
			.query({
				filter: JSON.stringify({
					_and: [{ collection: { _eq: childCollection } }, { item: { _eq: String(childId) } }],
				}),
				sort: '-id',
				limit: 1,
				fields: 'delta',
			})
			.set('Authorization', `Bearer ${adminToken}`);

		expect(revisions.statusCode).toBe(200);

		return revisions.body.data[0].delta;
	}

	beforeAll(async () => {
		for (const vendor of vendors) {
			await createCollection(vendor, parentCollection);
			await createCollection(vendor, childCollection);
			await createCollection(vendor, authorCollection);

			const nameFields = await Promise.all([
				common.CreateField(vendor, { collection: parentCollection, field: 'name', type: 'string' }),
				common.CreateField(vendor, { collection: childCollection, field: 'name', type: 'string' }),
				common.CreateField(vendor, { collection: authorCollection, field: 'name', type: 'string' }),
			]);

			for (const nameField of nameFields) {
				expect(nameField.field).toBe('name');
			}

			const noteField = await common.CreateField(vendor, {
				collection: childCollection,
				field: 'note',
				type: 'string',
			});

			expect(noteField.field).toBe('note');

			const o2m = await common.CreateFieldO2M(vendor, {
				collection: parentCollection,
				field: 'children',
				otherCollection: childCollection,
				otherField: 'parent_id',
				primaryKeyType: 'integer',
			});

			expect(o2m.field.field).toBe('children');
			expect(o2m.relation.field).toBe('parent_id');

			const m2o = await common.CreateFieldM2O(vendor, {
				collection: parentCollection,
				field: 'author',
				otherCollection: authorCollection,
				primaryKeyType: 'integer',
			});

			expect(m2o.field.field).toBe('author');
			expect(m2o.relation.related_collection).toBe(authorCollection);

			const metaRole = await createRole(vendor, `FR2b Metadata ${runId}`);
			await createUser(vendor, metaRole, metaToken, `fr2b-meta-${runId}-${vendor}@tests.com`);
			await grant(vendor, metaRole, parentCollection, 'read', ['*']);
			await grant(vendor, metaRole, parentCollection, 'update', ['*']);
			await grant(vendor, metaRole, childCollection, 'update', ['name'], { name: { _neq: 'Foreign child' } });
			await grant(vendor, metaRole, authorCollection, 'update', ['name']);

			const reparentRole = await createRole(vendor, `FR2b Reparent ${runId}`);
			await createUser(vendor, reparentRole, reparentToken, `fr2b-reparent-${runId}-${vendor}@tests.com`);
			await grant(vendor, reparentRole, parentCollection, 'read', ['*']);
			await grant(vendor, reparentRole, parentCollection, 'update', ['*']);
			await grant(vendor, reparentRole, childCollection, 'update', ['name', 'parent_id']);

			const noReadRole = await createRole(vendor, `FR2b No Read ${runId}`);
			await createUser(vendor, noReadRole, noReadToken, `fr2b-noread-${runId}-${vendor}@tests.com`);
			await grant(vendor, noReadRole, parentCollection, 'update', ['*']);
			await grant(vendor, noReadRole, childCollection, 'update', ['name']);

			await grant(
				vendor,
				noReadRole,
				childCollection,
				'create',
				['*'],
				{},
				{ note: 'Preset note' },
				{ parent_id: { _submitted: true } }
			);

			const author = await request(getUrl(vendor))
				.post(`/items/${authorCollection}`)
				.send({ name: 'Original author' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(author.statusCode).toBe(200);
			const authorId = author.body.data.id;

			const metadata = await seedParent(vendor, 'Metadata parent', 'Original child');
			const noop = await seedParent(vendor, 'No-op parent', 'No-op child');
			const reparentSource = await seedParent(vendor, 'Reparent source', 'Reparent child');
			const denyReparent = await seedParent(vendor, 'Deny reparent target', null);
			const foreign = await seedParent(vendor, 'Foreign parent', 'Foreign child');
			const noRead = await seedParent(vendor, 'No-read parent', 'No-read child');

			const m2oParent = await request(getUrl(vendor))
				.post(`/items/${parentCollection}`)
				.send({ name: 'M2O parent', author: authorId })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(m2oParent.statusCode).toBe(200);

			ids[vendor] = {
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
			};
		}
	}, 300000);

	afterAll(async () => {
		for (const vendor of vendors) {
			const stack = cleanups[vendor] ?? [];

			for (let i = stack.length - 1; i >= 0; i--) {
				await stack[i]!();
			}
		}
	});

	it.each(vendors)(
		'%s updates a linked o2m child (object-array) under a grant excluding the reverse field',
		async (vendor) => {
			const { metadataParent, metadataChild } = ids[vendor]!;

			const response = await request(getUrl(vendor))
				.patch(`/items/${parentCollection}/${metadataParent}`)
				.send({ children: [{ id: metadataChild, name: 'Renamed child' }] })
				.set('Authorization', `Bearer ${metaToken}`);

			expect(response.statusCode).toBe(200);

			const row = await childRow(vendor, metadataChild);
			expect(row.name).toBe('Renamed child');
			expect(row.parent_id).toBe(metadataParent);

			const delta = await latestChildRevisionDelta(vendor, metadataChild);
			expect(delta.name).toBe('Renamed child');
			expect(delta.parent_id).toBeUndefined();
		}
	);

	it.each(vendors)(
		'%s updates a linked o2m child (alterations) under a grant excluding the reverse field',
		async (vendor) => {
			const { reparentParent, reparentChild } = ids[vendor]!;

			const response = await request(getUrl(vendor))
				.patch(`/items/${parentCollection}/${reparentParent}`)
				.send({ children: { update: [{ id: reparentChild, name: 'Edited child' }] } })
				.set('Authorization', `Bearer ${metaToken}`);

			expect(response.statusCode).toBe(200);

			const row = await childRow(vendor, reparentChild);
			expect(row.name).toBe('Edited child');
			expect(row.parent_id).toBe(reparentParent);
		}
	);

	it.each(vendors)('%s treats a key-only already-linked child as a no-op with no new revision', async (vendor) => {
		const { noopParent, noopChild } = ids[vendor]!;

		const before = await childRevisionCount(vendor, noopChild);

		const response = await request(getUrl(vendor))
			.patch(`/items/${parentCollection}/${noopParent}`)
			.send({ children: [{ id: noopChild }] })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(200);

		const after = await childRevisionCount(vendor, noopChild);
		expect(after).toBe(before);

		const row = await childRow(vendor, noopChild);
		expect(row.name).toBe('No-op child');
		expect(row.parent_id).toBe(noopParent);
	});

	it.each(vendors)('%s rolls back the whole mutation when a nested reparent is denied', async (vendor) => {
		const { denyReparentParent, metadataChild } = ids[vendor]!;

		const parentBefore = await request(getUrl(vendor))
			.get(`/items/${parentCollection}/${denyReparentParent}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(parentBefore.statusCode).toBe(200);

		const childBefore = await childRow(vendor, metadataChild);

		const response = await request(getUrl(vendor))
			.patch(`/items/${parentCollection}/${denyReparentParent}`)
			.send({ name: 'Renamed parent', children: { update: [{ id: metadataChild, name: 'Should not move' }] } })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');

		const parentAfter = await request(getUrl(vendor))
			.get(`/items/${parentCollection}/${denyReparentParent}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(parentAfter.body.data.name).toBe(parentBefore.body.data.name);

		const childAfter = await childRow(vendor, metadataChild);
		expect(childAfter).toEqual(childBefore);
	});

	it.each(vendors)('%s allows a reparent when the reverse field is granted', async (vendor) => {
		const { denyReparentParent, reparentChild } = ids[vendor]!;

		const response = await request(getUrl(vendor))
			.patch(`/items/${parentCollection}/${denyReparentParent}`)
			.send({ children: { update: [{ id: reparentChild, name: 'Moved child' }] } })
			.set('Authorization', `Bearer ${reparentToken}`);

		expect(response.statusCode).toBe(200);

		const row = await childRow(vendor, reparentChild);
		expect(row.parent_id).toBe(denyReparentParent);
		expect(row.name).toBe('Moved child');
	});

	it.each(vendors)('%s rejects a nested update targeting a permission-filtered foreign child', async (vendor) => {
		const { foreignParent, foreignChild } = ids[vendor]!;

		const response = await request(getUrl(vendor))
			.patch(`/items/${parentCollection}/${foreignParent}`)
			.send({ children: { update: [{ id: foreignChild, name: 'Hijacked' }] } })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(403);
		expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');

		const row = await childRow(vendor, foreignChild);
		expect(row.name).toBe('Foreign child');
	});

	it.each(vendors)('%s persists a nested update for a caller without read access', async (vendor) => {
		const { noReadParent, noReadChild } = ids[vendor]!;

		const response = await request(getUrl(vendor))
			.patch(`/items/${parentCollection}/${noReadParent}`)
			.send({ children: { update: [{ id: noReadChild, name: 'Written without read' }] } })
			.set('Authorization', `Bearer ${noReadToken}`);

		expect(response.statusCode).toBe(204);

		const row = await childRow(vendor, noReadChild);
		expect(row.name).toBe('Written without read');
		expect(row.parent_id).toBe(noReadParent);
	});

	it.each(vendors)('%s creates a nested child applying a preset and the required association', async (vendor) => {
		const { noReadParent } = ids[vendor]!;

		const response = await request(getUrl(vendor))
			.patch(`/items/${parentCollection}/${noReadParent}`)
			.send({ children: { create: [{ name: 'Nested created child' }] } })
			.set('Authorization', `Bearer ${noReadToken}`);

		expect(response.statusCode).toBe(204);

		const readBack = await request(getUrl(vendor))
			.get(`/items/${parentCollection}/${noReadParent}`)
			.query({ fields: 'children.name,children.note,children.parent_id' })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(readBack.statusCode).toBe(200);
		const created = readBack.body.data.children.find((child: any) => child.name === 'Nested created child');
		expect(created).toBeDefined();
		expect(created.parent_id).toBe(noReadParent);
		expect(created.note).toBe('Preset note');
	});

	it.each(vendors)('%s rejects a direct child create that omits the required association', async (vendor) => {
		const response = await request(getUrl(vendor))
			.post(`/items/${childCollection}`)
			.send({ name: 'Orphan child' })
			.set('Authorization', `Bearer ${noReadToken}`);

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('FAILED_VALIDATION');

		const readBack = await request(getUrl(vendor))
			.get(`/items/${childCollection}`)
			.query({ filter: JSON.stringify({ name: { _eq: 'Orphan child' } }) })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(readBack.body.data).toHaveLength(0);
	});

	it.each(vendors)('%s updates m2o content under a grant that excludes the related key', async (vendor) => {
		const { m2oParent, author } = ids[vendor]!;

		const response = await request(getUrl(vendor))
			.patch(`/items/${parentCollection}/${m2oParent}`)
			.send({ author: { id: author, name: 'Renamed author' } })
			.set('Authorization', `Bearer ${metaToken}`);

		expect(response.statusCode).toBe(200);

		const readBack = await request(getUrl(vendor))
			.get(`/items/${authorCollection}/${author}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.name).toBe('Renamed author');
	});
});

describe('Nested junction (m2m) write selector and link separation', () => {
	const m2mParent = `test_fr2b_m2m_parent_${runId}`;
	const tagCollection = `test_fr2b_tag_${runId}`;
	const junctionCollection = `test_fr2b_ptag_${runId}`;
	const reverseField = `${m2mParent}_id`;
	const tagField = `${tagCollection}_id`;
	const junctionToken = `Fr2bJunction_${runId}`;

	const cleanups: (() => Promise<void>)[] = [];
	const ids = {} as Record<string, { parent: string; junction: string; tag: string }>;

	function track(fn: () => Promise<void>) {
		cleanups.push(fn);
	}

	beforeAll(async () => {
		for (const vendor of vendors) {
			const m2mColl = await common.CreateCollection(vendor, { collection: m2mParent });

			track(async () => {
				await request(getUrl(vendor)).delete(`/collections/${m2mParent}`).set('Authorization', `Bearer ${adminToken}`);
			});

			expect(m2mColl.collection).toBe(m2mParent);

			const tagColl = await common.CreateCollection(vendor, { collection: tagCollection });

			track(async () => {
				await request(getUrl(vendor))
					.delete(`/collections/${tagCollection}`)
					.set('Authorization', `Bearer ${adminToken}`);
			});

			expect(tagColl.collection).toBe(tagCollection);

			await common.CreateField(vendor, { collection: m2mParent, field: 'name', type: 'string' });
			await common.CreateField(vendor, { collection: tagCollection, field: 'name', type: 'string' });

			const m2m = await common.CreateFieldM2M(vendor, {
				collection: m2mParent,
				field: 'tags',
				otherCollection: tagCollection,
				otherField: 'parents',
				junctionCollection,
				primaryKeyType: 'integer',
			});

			// Deleting the M2M field does not delete its junction collection.
			track(async () => {
				await request(getUrl(vendor))
					.delete(`/collections/${junctionCollection}`)
					.set('Authorization', `Bearer ${adminToken}`);
			});

			expect(m2m.junctionCollection).toBeDefined();

			const label = await common.CreateField(vendor, {
				collection: junctionCollection,
				field: 'label',
				type: 'string',
			});

			expect(label.field).toBe('label');

			const role = await request(getUrl(vendor))
				.post('/roles')
				.send({ name: `FR2b Junction ${runId}`, admin_access: false, app_access: true })
				.set('Authorization', `Bearer ${adminToken}`);

			const roleId = role.body?.data?.id as string | undefined;

			if (roleId) {
				track(async () => {
					await request(getUrl(vendor)).delete(`/roles/${roleId}`).set('Authorization', `Bearer ${adminToken}`);
				});
			}

			expect(role.statusCode).toBe(200);

			const user = await request(getUrl(vendor))
				.post('/users')
				.send({
					email: `fr2b-junction-${runId}-${vendor}@tests.com`,
					password: 'Fr2bPassword',
					token: junctionToken,
					role: roleId,
					status: 'active',
				})
				.set('Authorization', `Bearer ${adminToken}`);

			const userId = user.body?.data?.id as string | undefined;

			if (userId) {
				track(async () => {
					await request(getUrl(vendor)).delete(`/users/${userId}`).set('Authorization', `Bearer ${adminToken}`);
				});
			}

			expect(user.statusCode).toBe(200);

			for (const [collection, action, fields] of [
				[m2mParent, 'read', ['*']],
				[m2mParent, 'update', ['*']],
				// The parent link must not be rewritten.
				[junctionCollection, 'update', ['label', tagField]],
				[tagCollection, 'update', ['name']],
			] as const) {
				const permission = await request(getUrl(vendor))
					.post('/permissions')
					.send({ role: roleId, collection, action, fields })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(permission.statusCode).toBe(200);
			}

			const created = await request(getUrl(vendor))
				.post(`/items/${m2mParent}`)
				.send({ name: 'M2M parent', tags: { create: [{ label: 'Original label', [tagField]: { name: 'Tag A' } }] } })
				.query({ fields: `id,tags.id,tags.${tagField}` })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(created.statusCode).toBe(200);

			ids[vendor] = {
				parent: created.body.data.id,
				junction: created.body.data.tags[0].id,
				tag: created.body.data.tags[0][tagField],
			};
		}
	}, 300000);

	afterAll(async () => {
		for (let i = cleanups.length - 1; i >= 0; i--) {
			await cleanups[i]!();
		}
	});

	it.each(vendors)('%s updates junction metadata under a grant excluding the reverse field', async (vendor) => {
		const { parent, junction } = ids[vendor]!;

		const response = await request(getUrl(vendor))
			.patch(`/items/${m2mParent}/${parent}`)
			.send({ tags: { update: [{ id: junction, label: 'Edited label' }] } })
			.set('Authorization', `Bearer ${junctionToken}`);

		expect(response.statusCode).toBe(200);

		const readBack = await request(getUrl(vendor))
			.get(`/items/${junctionCollection}/${junction}`)
			.query({ fields: `label,${reverseField}` })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.label).toBe('Edited label');
		expect(readBack.body.data[reverseField]).toBe(parent);
	});

	it.each(vendors)('%s updates related-tag content through the junction under narrow grants', async (vendor) => {
		const { parent, junction, tag } = ids[vendor]!;

		const response = await request(getUrl(vendor))
			.patch(`/items/${m2mParent}/${parent}`)
			.send({ tags: { update: [{ id: junction, [tagField]: { id: tag, name: 'Renamed tag' } }] } })
			.set('Authorization', `Bearer ${junctionToken}`);

		expect(response.statusCode).toBe(200);

		const readBack = await request(getUrl(vendor))
			.get(`/items/${tagCollection}/${tag}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(readBack.statusCode).toBe(200);
		expect(readBack.body.data.name).toBe('Renamed tag');
	});
});

describe('Nested any (m2a) write selector and link separation', () => {
	const m2aParent = `test_fr2b_m2a_parent_${runId}`;
	const blockCollection = `test_fr2b_block_${runId}`;
	const junctionM2A = `test_fr2b_blockjunc_${runId}`;
	const reverseFieldM2A = `${junctionM2A}_id`;
	const m2aToken = `Fr2bM2aAllow_${runId}`;
	const denyToken = `Fr2bM2aDeny_${runId}`;
	const discDenyToken = `Fr2bM2aDiscDeny_${runId}`;

	const cleanups: (() => Promise<void>)[] = [];
	const ids = {} as Record<string, { parent: string; block: string; junction: string }>;

	function track(fn: () => Promise<void>) {
		cleanups.push(fn);
	}

	async function makeRoleUser(
		vendor: string,
		name: string,
		token: string,
		junctionUpdateFields: string[],
		blockUpdateFields: string[]
	) {
		const role = await request(getUrl(vendor))
			.post('/roles')
			.send({ name, admin_access: false, app_access: true })
			.set('Authorization', `Bearer ${adminToken}`);

		const roleId = role.body?.data?.id as string | undefined;

		if (roleId) {
			track(async () => {
				await request(getUrl(vendor)).delete(`/roles/${roleId}`).set('Authorization', `Bearer ${adminToken}`);
			});
		}

		expect(role.statusCode).toBe(200);

		const user = await request(getUrl(vendor))
			.post('/users')
			.send({ email: `${token}-${vendor}@tests.com`, password: 'Fr2bPassword', token, role: roleId, status: 'active' })
			.set('Authorization', `Bearer ${adminToken}`);

		const userId = user.body?.data?.id as string | undefined;

		if (userId) {
			track(async () => {
				await request(getUrl(vendor)).delete(`/users/${userId}`).set('Authorization', `Bearer ${adminToken}`);
			});
		}

		expect(user.statusCode).toBe(200);

		for (const [collection, action, fields] of [
			[m2aParent, 'read', ['*']],
			[m2aParent, 'update', ['*']],
			// The parent link must not be rewritten.
			[junctionM2A, 'update', junctionUpdateFields],
			[blockCollection, 'update', blockUpdateFields],
		] as const) {
			const permission = await request(getUrl(vendor))
				.post('/permissions')
				.send({ role: roleId, collection, action, fields })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(permission.statusCode).toBe(200);
		}
	}

	beforeAll(async () => {
		for (const vendor of vendors) {
			const parentColl = await common.CreateCollection(vendor, { collection: m2aParent });

			track(async () => {
				await request(getUrl(vendor)).delete(`/collections/${m2aParent}`).set('Authorization', `Bearer ${adminToken}`);
			});

			expect(parentColl.collection).toBe(m2aParent);

			const blockColl = await common.CreateCollection(vendor, { collection: blockCollection });

			track(async () => {
				await request(getUrl(vendor))
					.delete(`/collections/${blockCollection}`)
					.set('Authorization', `Bearer ${adminToken}`);
			});

			expect(blockColl.collection).toBe(blockCollection);

			await common.CreateField(vendor, { collection: m2aParent, field: 'name', type: 'string' });
			await common.CreateField(vendor, { collection: blockCollection, field: 'name', type: 'string' });
			// This content field intentionally shares the routing field's name.
			await common.CreateField(vendor, { collection: blockCollection, field: 'collection', type: 'string' });

			const m2a = await common.CreateFieldM2A(vendor, {
				collection: m2aParent,
				field: 'blocks',
				relatedCollections: [blockCollection],
				junctionCollection: junctionM2A,
				primaryKeyType: 'integer',
			});

			track(async () => {
				await request(getUrl(vendor))
					.delete(`/collections/${junctionM2A}`)
					.set('Authorization', `Bearer ${adminToken}`);
			});

			expect(m2a.junctionCollection).toBeDefined();

			await makeRoleUser(vendor, `FR2b M2A Allow ${runId}`, m2aToken, ['item', 'collection'], ['name', 'collection']);
			await makeRoleUser(vendor, `FR2b M2A Deny ${runId}`, denyToken, ['item', 'collection'], ['collection']);
			await makeRoleUser(vendor, `FR2b M2A Disc Deny ${runId}`, discDenyToken, ['item'], ['name', 'collection']);

			const parent = await request(getUrl(vendor))
				.post(`/items/${m2aParent}`)
				.send({ name: 'M2A parent' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(parent.statusCode).toBe(200);
			const parentId = parent.body.data.id;

			const block = await request(getUrl(vendor))
				.post(`/items/${blockCollection}`)
				.send({ name: 'Block A', collection: 'own-original' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(block.statusCode).toBe(200);
			const blockId = block.body.data.id;

			const junction = await request(getUrl(vendor))
				.post(`/items/${junctionM2A}`)
				.send({ [reverseFieldM2A]: parentId, collection: blockCollection, item: String(blockId) })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(junction.statusCode).toBe(200);

			ids[vendor] = { parent: parentId, block: blockId, junction: junction.body.data.id };
		}
	}, 300000);

	afterAll(async () => {
		for (let i = cleanups.length - 1; i >= 0; i--) {
			await cleanups[i]!();
		}
	});

	it.each(vendors)(
		'%s updates a2o related content, including a same-named field, and preserves the discriminator',
		async (vendor) => {
			const { parent, block, junction } = ids[vendor]!;

			const response = await request(getUrl(vendor))
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

			const blockBack = await request(getUrl(vendor))
				.get(`/items/${blockCollection}/${block}`)
				.query({ fields: 'name,collection' })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(blockBack.statusCode).toBe(200);
			expect(blockBack.body.data.name).toBe('Block updated');
			expect(blockBack.body.data.collection).toBe('own-updated');

			const junctionBack = await request(getUrl(vendor))
				.get(`/items/${junctionM2A}/${junction}`)
				.query({ fields: `collection,${reverseFieldM2A}` })
				.set('Authorization', `Bearer ${adminToken}`);

			expect(junctionBack.body.data.collection).toBe(blockCollection);
			expect(junctionBack.body.data[reverseFieldM2A]).toBe(parent);
		}
	);

	async function adminRead(vendor: string, collection: string, key: string, fields: string) {
		const response = await request(getUrl(vendor))
			.get(`/items/${collection}/${key}`)
			.query({ fields })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(response.statusCode).toBe(200);

		return response.body.data;
	}

	it.each(vendors)('%s rolls back the whole mutation when a2o related content is denied', async (vendor) => {
		const { parent, block, junction } = ids[vendor]!;

		const parentBefore = await adminRead(vendor, m2aParent, parent, 'name');
		const blockBefore = await adminRead(vendor, blockCollection, block, 'name,collection');
		const junctionBefore = await adminRead(vendor, junctionM2A, junction, `collection,${reverseFieldM2A}`);

		const response = await request(getUrl(vendor))
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

		expect(await adminRead(vendor, m2aParent, parent, 'name')).toEqual(parentBefore);
		expect(await adminRead(vendor, blockCollection, block, 'name,collection')).toEqual(blockBefore);
		expect(await adminRead(vendor, junctionM2A, junction, `collection,${reverseFieldM2A}`)).toEqual(junctionBefore);
	});

	it.each(vendors)(
		'%s rejects an a2o discriminator write that is not granted and leaves rows unchanged',
		async (vendor) => {
			const { parent, block, junction } = ids[vendor]!;

			const blockBefore = await adminRead(vendor, blockCollection, block, 'name,collection');
			const junctionBefore = await adminRead(vendor, junctionM2A, junction, `collection,${reverseFieldM2A}`);

			const response = await request(getUrl(vendor))
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

			expect(await adminRead(vendor, blockCollection, block, 'name,collection')).toEqual(blockBefore);
			expect(await adminRead(vendor, junctionM2A, junction, `collection,${reverseFieldM2A}`)).toEqual(junctionBefore);
		}
	);
});
