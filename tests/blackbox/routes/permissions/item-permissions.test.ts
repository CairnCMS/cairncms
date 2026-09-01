import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

const adminToken = common.USER.ADMIN.TOKEN;
const flowToken = common.USER.TESTS_FLOW.TOKEN;

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

async function deleteResource(vendor: string, resource: string): Promise<CleanupResult> {
	try {
		const response = await request(getUrl(vendor)).delete(resource).set('Authorization', `Bearer ${flowToken}`);

		if (response.statusCode >= 400 && response.statusCode !== 404) {
			return { ok: false, reason: `DELETE ${resource} on ${vendor} returned ${response.statusCode}` };
		}

		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `DELETE ${resource} on ${vendor} threw ${String(error)}` };
	}
}

describe('/permissions/me item permissions', () => {
	const alphaItemIds = {} as { [vendor: string]: number };
	const betaItemIds = {} as { [vendor: string]: number };
	const shareIds = {} as { [vendor: string]: string };
	const shareVisitorTokens = {} as { [vendor: string]: string };
	const cleanups: Array<{ vendor: string; run: () => Promise<CleanupResult> }> = [];

	beforeAll(async () => {
		for (const vendor of vendors) {
			const url = getUrl(vendor);

			const asAdminPost = (path: string, payload: Record<string, unknown>) =>
				request(url).post(path).set('Authorization', `Bearer ${adminToken}`).send(payload);

			const createRole = async (name: string) => {
				const role = await common.CreateRole(vendor, {
					name,
					appAccessEnabled: false,
					adminAccessEnabled: false,
				});

				cleanups.push({ vendor, run: () => deleteResource(vendor, `/roles/${role?.id}`) });
				expect(role.id).toBeDefined();
				return role;
			};

			const createUser = async (token: string, email: string, roleId: string) => {
				const user = await common.CreateUser(vendor, { token, email, role: roleId });
				cleanups.push({ vendor, run: () => deleteResource(vendor, `/users/${user?.id}`) });
				expect(user.id).toBeDefined();
				return user;
			};

			const tenant = await common.CreateCollection(vendor, {
				collection,
				fields: [
					{ field: 'title', type: 'string' },
					{ field: 'region', type: 'string' },
				],
			});

			cleanups.push({ vendor, run: () => deleteResource(vendor, `/collections/${collection}`) });
			expect(tenant.collection).toBe(collection);

			const owner = await common.CreateFieldM2O(vendor, {
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

			const alphaItem = await common.CreateItem(vendor, {
				collection,
				item: { title: 'alpha-doc', region: 'north', owner: alphaUser.id },
			});

			const betaItem = await common.CreateItem(vendor, {
				collection,
				item: { title: 'beta-doc', region: 'south', owner: betaUser.id },
			});

			expect(alphaItem.id).toBeDefined();
			expect(betaItem.id).toBeDefined();
			alphaItemIds[vendor] = alphaItem.id;
			betaItemIds[vendor] = betaItem.id;

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
			cleanups.push({ vendor, run: () => deleteResource(vendor, `/shares/${shareId}`) });
			expect(share.statusCode).toBe(200);
			expect(shareId).toBeDefined();
			shareIds[vendor] = shareId;

			const shareAuth = await request(url).post('/shares/auth').send({ share: shareId });
			const shareVisitorToken = shareAuth.body?.data?.access_token;
			expect(shareAuth.statusCode).toBe(200);
			expect(typeof shareVisitorToken).toBe('string');
			expect(shareVisitorToken.length).toBeGreaterThan(0);
			shareVisitorTokens[vendor] = shareVisitorToken;

			const singleton = await common.CreateCollection(vendor, {
				collection: singletonCollection,
				meta: { singleton: true },
				fields: [{ field: 'label', type: 'string' }],
			});

			cleanups.push({ vendor, run: () => deleteResource(vendor, `/collections/${singletonCollection}`) });
			expect(singleton.collection).toBe(singletonCollection);

			const singletonPermission = await asAdminPost('/permissions', {
				role: singletonRole.id,
				collection: singletonCollection,
				action: 'update',
				fields: ['*'],
			});

			expect(singletonPermission.statusCode).toBe(200);

			const singletonRow = await request(url)
				.patch(`/items/${singletonCollection}`)
				.set('Authorization', `Bearer ${adminToken}`)
				.send({ label: 'only' });

			expect(singletonRow.statusCode).toBe(200);
			expect(singletonRow.body.data.label).toBe('only');
		}
	}, 300000);

	afterAll(async () => {
		const failures: string[] = [];

		for (const cleanup of cleanups.reverse()) {
			const result = await cleanup.run();
			if (!result.ok) failures.push(result.reason);
		}

		if (failures.length > 0) {
			throw new Error(`item permissions cleanup failed: ${failures.join(', ')}`);
		}
	});

	const me = (vendor: string, target: string, token?: string) => {
		const pending = request(getUrl(vendor)).get(`/permissions/me/${target}`);
		return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
	};

	it.each(vendors)('%s reports a conditional update capability without read access', async (vendor) => {
		const read = await request(getUrl(vendor))
			.get(`/items/${collection}/${alphaItemIds[vendor]}`)
			.set('Authorization', `Bearer ${alphaToken}`);

		expect(read.statusCode).toBe(403);

		const response = await me(vendor, `${collection}/${alphaItemIds[vendor]}`, alphaToken);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual(granted);
	});

	it.each(vendors)(
		'%s conceals a forbidden, missing, malformed, and unknown-collection target behind one response',
		async (vendor) => {
			const inaccessible = await me(vendor, `${collection}/${betaItemIds[vendor]}`, alphaToken);
			const nonexistent = await me(vendor, `${collection}/999999999`, alphaToken);
			const malformed = await me(vendor, `${collection}/not-a-valid-key`, alphaToken);
			const unknownKeyed = await me(vendor, `${unknownCollection}/1`, alphaToken);

			for (const response of [inaccessible, nonexistent, malformed, unknownKeyed]) {
				expect(response.statusCode).toBe(200);
				expect(response.body.data).toEqual(denied);
			}

			expect(nonexistent.text).toBe(inaccessible.text);
			expect(malformed.text).toBe(inaccessible.text);
			expect(unknownKeyed.text).toBe(inaccessible.text);
		}
	);

	it.each(vendors)('%s isolates the second tenant symmetrically', async (vendor) => {
		const own = await me(vendor, `${collection}/${betaItemIds[vendor]}`, betaToken);

		expect(own.statusCode).toBe(200);
		expect(own.body.data).toEqual(granted);

		const other = await me(vendor, `${collection}/${alphaItemIds[vendor]}`, betaToken);

		expect(other.statusCode).toBe(200);
		expect(other.body.data).toEqual(denied);
	});

	it.each(vendors)('%s gives an admin no existence oracle', async (vendor) => {
		const existing = await me(vendor, `${collection}/${alphaItemIds[vendor]}`, adminToken);

		expect(existing.statusCode).toBe(200);

		expect(existing.body.data).toEqual({
			update: { access: true, fields: ['*'] },
			delete: { access: true },
			share: { access: true },
		});

		const missing = await me(vendor, `${collection}/999999999`, adminToken);

		expect(missing.statusCode).toBe(200);
		expect(missing.body.data).toEqual(denied);
	});

	it.each(vendors)('%s rejects an unauthenticated request before classifying the target', async (vendor) => {
		const response = await me(vendor, `${unknownCollection}/not-a-valid-key`);

		expect(response.statusCode).toBe(401);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_CREDENTIALS');
		expect(response.body.data).toBeUndefined();
	});

	it.each(vendors)('%s rejects share accountability', async (vendor) => {
		const response = await me(vendor, `${collection}/${alphaItemIds[vendor]}`, shareVisitorTokens[vendor]);

		expect(response.statusCode).toBe(401);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_CREDENTIALS');
		expect(response.body.data).toBeUndefined();
	});

	it.each(vendors)('%s reports a capability result for a directus_shares item', async (vendor) => {
		const response = await me(vendor, `directus_shares/${shareIds[vendor]}`, sharesToken);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual(grantedAll);
	});

	it.each(vendors)('%s does not disclose collection existence through a keyless request', async (vendor) => {
		const keylessKnown = await me(vendor, `${collection}`, alphaToken);
		const keylessUnknown = await me(vendor, `${unknownCollection}`, alphaToken);

		expect(keylessKnown.statusCode).toBe(400);
		expect(keylessUnknown.statusCode).toBe(400);
		expect(keylessKnown.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(keylessKnown.body.errors[0].message).toBe('A primary key is required');
		expect(keylessKnown.text).toBe(keylessUnknown.text);
	});

	it.each(vendors)('%s resolves a singleton capability without a key', async (vendor) => {
		const response = await me(vendor, `${singletonCollection}`, singletonToken);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual(grantedAll);
	});
});
