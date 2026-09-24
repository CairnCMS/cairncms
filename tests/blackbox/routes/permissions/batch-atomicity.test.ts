import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

const adminToken = common.USER.ADMIN.TOKEN;
const flowToken = common.USER.TESTS_FLOW.TOKEN;

const run = randomUUID().slice(0, 8);
const collection = `test_batch_atomicity_${run}`;
const alphaRoleName = `batch_atomicity_alpha_${run}`;
const betaRoleName = `batch_atomicity_beta_${run}`;
const alphaToken = `BatchAtomicityAlpha${run}`;
const betaToken = `BatchAtomicityBeta${run}`;

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

describe('items batch mutation atomicity', () => {
	const ownedFirst = {} as { [vendor: string]: number };
	const ownedSecond = {} as { [vendor: string]: number };
	const foreign = {} as { [vendor: string]: number };
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
				fields: [{ field: 'title', type: 'string' }],
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
			const alphaUser = await createUser(alphaToken, `batch-atomicity-alpha-${run}@example.com`, alphaRole.id);
			const betaUser = await createUser(betaToken, `batch-atomicity-beta-${run}@example.com`, betaRole.id);

			const first = await common.CreateItem(vendor, {
				collection,
				item: { title: 'alpha-1', owner: alphaUser.id },
			});

			const second = await common.CreateItem(vendor, {
				collection,
				item: { title: 'alpha-2', owner: alphaUser.id },
			});

			const other = await common.CreateItem(vendor, {
				collection,
				item: { title: 'beta-1', owner: betaUser.id },
			});

			expect(first.id).toBeDefined();
			expect(second.id).toBeDefined();
			expect(other.id).toBeDefined();
			ownedFirst[vendor] = first.id;
			ownedSecond[vendor] = second.id;
			foreign[vendor] = other.id;

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
		}
	}, 300000);

	afterAll(async () => {
		const failures: string[] = [];

		for (const cleanup of cleanups.reverse()) {
			const result = await cleanup.run();
			if (!result.ok) failures.push(result.reason);
		}

		if (failures.length > 0) {
			throw new Error(`batch atomicity cleanup failed: ${failures.join(', ')}`);
		}
	});

	const readRows = async (vendor: string, ids: number[]) => {
		const read = await request(getUrl(vendor))
			.get(`/items/${collection}?filter[id][_in]=${ids.join(',')}&fields=id,title&sort=id`)
			.set('Authorization', `Bearer ${adminToken}`);

		expect(read.statusCode).toBe(200);
		return read.body.data as Array<{ id: number; title: string }>;
	};

	it.each(vendors)(
		'%s enforces atomic all-or-nothing batch mutation for a conditional role',
		async (vendor) => {
			const url = getUrl(vendor);
			const first = ownedFirst[vendor]!;
			const second = ownedSecond[vendor]!;
			const other = foreign[vendor]!;

			const allOwnedUpdate = await request(url)
				.patch(`/items/${collection}`)
				.set('Authorization', `Bearer ${alphaToken}`)
				.send({ keys: [first, second], data: { title: 'batch-updated' } });

			expect(allOwnedUpdate.statusCode).toBe(204);

			const afterOwnedUpdate = await readRows(vendor, [first, second]);
			expect(afterOwnedUpdate.map((row) => row.title)).toEqual(['batch-updated', 'batch-updated']);

			const mixedUpdate = await request(url)
				.patch(`/items/${collection}`)
				.set('Authorization', `Bearer ${alphaToken}`)
				.send({ keys: [first, other], data: { title: 'should-not-apply' } });

			expect(mixedUpdate.statusCode).toBe(403);
			expect(mixedUpdate.body.errors[0].extensions.code).toBe('FORBIDDEN');

			const afterMixedUpdate = await readRows(vendor, [first, other]);
			const titlesById = Object.fromEntries(afterMixedUpdate.map((row) => [row.id, row.title]));
			expect(titlesById[first]).toBe('batch-updated');
			expect(titlesById[other]).toBe('beta-1');

			const mixedDelete = await request(url)
				.delete(`/items/${collection}`)
				.set('Authorization', `Bearer ${alphaToken}`)
				.send([second, other]);

			expect(mixedDelete.statusCode).toBe(403);
			expect(mixedDelete.body.errors[0].extensions.code).toBe('FORBIDDEN');

			const afterMixedDelete = await readRows(vendor, [second, other]);
			expect(afterMixedDelete.map((row) => row.id)).toEqual([second, other].sort((a, b) => a - b));

			const allOwnedDelete = await request(url)
				.delete(`/items/${collection}`)
				.set('Authorization', `Bearer ${alphaToken}`)
				.send([first, second]);

			expect(allOwnedDelete.statusCode).toBe(204);

			const afterOwnedDelete = await readRows(vendor, [first, second, other]);
			expect(afterOwnedDelete.map((row) => row.id)).toEqual([other]);
		},
		60000
	);
});
