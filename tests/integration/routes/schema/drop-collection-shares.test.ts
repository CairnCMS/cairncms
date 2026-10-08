import { describe, expect } from 'vitest';
import type { Test } from 'supertest';
import type { Api } from '../../fixtures/environment';
import { identityTest as test } from '../../fixtures/identities';
import { CreateCollection } from '../../fixtures/data';
import * as common from '../../fixtures/data';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const adminAuth = (req: Test) => req.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

type Share = { id: string; cookie: string };

async function deleteResource(api: Api, path: string) {
	const res = await adminAuth(request(api.url).delete(path));
	expect([204, 403, 404]).toContain(res.statusCode);
}

async function createShare(api: Api, collection: string, role: string): Promise<Share> {
	const item = await adminAuth(
		request(api.url)
			.post(`/items/${collection}`)
			.send({ title: `${collection}-item` })
	);

	expect(item.statusCode).toBe(200);

	const share = await adminAuth(
		request(api.url)
			.post('/shares')
			.send({ collection, item: String(item.body.data.id), role, name: collection })
	);

	expect(share.statusCode).toBe(200);

	const signIn = await request(api.url).post('/shares/auth').send({ share: share.body.data.id });
	expect(signIn.statusCode).toBe(200);

	const cookie = ([] as string[])
		.concat(signIn.headers['set-cookie'] ?? [])
		.map((header) => header.split(';')[0]!)
		.find((pair) => pair.includes('refresh_token='));

	expect(cookie).toBeDefined();

	return { id: share.body.data.id, cookie: cookie! };
}

async function shareRows(api: Api, share: string) {
	return {
		shares: await api.database('directus_shares').where({ id: share }),
		sessions: await api.database('directus_sessions').where({ share }),
	};
}

function refresh(api: Api, share: Share) {
	return request(api.url).post('/auth/refresh').set('Cookie', share.cookie).send({ mode: 'cookie' });
}

async function dropWithSchemaApply(api: Api, collection: string) {
	const snapshot = await adminAuth(request(api.url).get('/schema/snapshot'));
	expect(snapshot.statusCode).toBe(200);

	const desired = snapshot.body.data;
	desired.collections = desired.collections.filter((entry: any) => entry.collection !== collection);
	desired.fields = desired.fields.filter((entry: any) => entry.collection !== collection);
	desired.relations = desired.relations.filter((entry: any) => entry.collection !== collection);

	const diff = await adminAuth(
		request(api.url).post('/schema/diff').send(desired).set('Content-type', 'application/json')
	);

	expect(diff.statusCode).toBe(200);

	const apply = await adminAuth(
		request(api.url).post('/schema/apply').send(diff.body.data).set('Content-type', 'application/json')
	);

	expect(apply.statusCode).toBe(204);
}

async function dropWithCollectionDelete(api: Api, collection: string) {
	const res = await adminAuth(request(api.url).delete(`/collections/${collection}`));
	expect(res.statusCode).toBe(204);
}

describe.each([
	['schema apply', dropWithSchemaApply],
	['the collection endpoint', dropWithCollectionDelete],
])('dropping a collection through %s', (label, drop) => {
	test('removes its shares and their sessions and leaves other shares working', async ({ api, vendor }) => {
		const suffix = `${vendor}_${label === 'schema apply' ? 'apply' : 'endpoint'}`;
		const dropped = `test_drop_shares_dropped_${suffix}`;
		const kept = `test_drop_shares_kept_${suffix}`;

		await deleteResource(api, `/collections/${dropped}`);
		await deleteResource(api, `/collections/${kept}`);

		const role = await adminAuth(
			request(api.url)
				.post('/roles')
				.send({ name: `drop-shares-${suffix}`, app_access: false, admin_access: false })
		);

		expect(role.statusCode).toBe(200);

		try {
			for (const collection of [dropped, kept]) {
				await CreateCollection(api, { collection, fields: [{ field: 'title', type: 'string' }] });
			}

			const droppedShare = await createShare(api, dropped, role.body.data.id);
			const keptShare = await createShare(api, kept, role.body.data.id);

			expect((await shareRows(api, droppedShare.id)).sessions).toHaveLength(1);
			expect((await shareRows(api, keptShare.id)).sessions).toHaveLength(1);

			await drop(api, dropped);

			expect(await shareRows(api, droppedShare.id)).toEqual({ shares: [], sessions: [] });
			expect(await api.database('directus_shares').where({ collection: dropped })).toEqual([]);
			expect((await request(api.url).post('/shares/auth').send({ share: droppedShare.id })).statusCode).toBe(401);
			expect((await refresh(api, droppedShare)).statusCode).toBe(401);

			const keptRows = await shareRows(api, keptShare.id);
			expect(keptRows.shares).toHaveLength(1);
			expect(keptRows.sessions).toHaveLength(1);
			expect((await refresh(api, keptShare)).statusCode).toBe(200);
		} finally {
			await deleteResource(api, `/collections/${dropped}`);
			await deleteResource(api, `/collections/${kept}`);
			await deleteResource(api, `/roles/${role.body.data.id}`);
		}
	});
});
