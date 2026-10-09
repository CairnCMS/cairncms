import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Test } from 'supertest';
import type { Api } from '../../fixtures/environment';
import { identityTest as test } from '../../fixtures/identities';
import { CreateCollection, CreateFieldM2O, CreateRole } from '../../fixtures/schema';
import * as common from '../../fixtures/data';
import request, { requestGraphQL, setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const adminToken = common.USER.ADMIN!.TOKEN;
const adminAuth = (req: Test) => req.set('Authorization', `Bearer ${adminToken}`);

type Pair = { authors: string; articles: string };

function pairNames(suffix: string): Pair {
	return { authors: `del_ref_authors_${suffix}`, articles: `del_ref_articles_${suffix}` };
}

async function createPair(api: Api, pair: Pair, onDelete: string) {
	await CreateCollection(api, {
		collection: pair.authors,
		meta: { accountability: 'all' },
		fields: [{ field: 'name', type: 'string' }],
	});

	await CreateCollection(api, { collection: pair.articles, fields: [{ field: 'title', type: 'string' }] });

	await CreateFieldM2O(api, {
		collection: pair.articles,
		field: 'author',
		otherCollection: pair.authors,
		relationSchema: { on_delete: onDelete },
	});
}

async function createItem(api: Api, collection: string, item: Record<string, unknown>) {
	const res = await adminAuth(setupRequest(api.url).post(`/items/${collection}`).send(item)).expect(200);
	return res.body.data.id;
}

async function rows(api: Api, collection: string) {
	return api.database(collection).orderBy('id');
}

async function deleteActivity(api: Api, collection: string) {
	return api.database('directus_activity').where({ collection, action: 'delete' });
}

async function cleanupResource(api: Api, path: string) {
	const res = await adminAuth(request(api.url).delete(path));
	expect([204, 403, 404]).toContain(res.statusCode);
}

async function cleanupPair(api: Api, pair: Pair) {
	await cleanupResource(api, `/collections/${pair.articles}`);
	await cleanupResource(api, `/collections/${pair.authors}`);
}

test('refuses to delete a referenced item and changes nothing', async ({ api, vendor }) => {
	const pair = pairNames(`single_${vendor}_${randomUUID().slice(0, 8)}`);

	try {
		await createPair(api, pair, 'NO ACTION');

		const annId = await createItem(api, pair.authors, { name: 'Ann' });
		await createItem(api, pair.articles, { title: 'By Ann', author: annId });

		const authorsBefore = await rows(api, pair.authors);
		const articlesBefore = await rows(api, pair.articles);

		const res = await adminAuth(request(api.url).delete(`/items/${pair.authors}/${annId}`));

		expect(res.statusCode).toBe(400);
		expect(res.body.errors[0].extensions.code).toBe('RECORD_STILL_REFERENCED');
		expect(res.body.errors[0].message).toBe(`Item can't be deleted because other items still reference it.`);

		expect(await rows(api, pair.authors)).toEqual(authorsBefore);
		expect(await rows(api, pair.articles)).toEqual(articlesBefore);
		expect(articlesBefore[0].author).toBe(annId);
		expect(await deleteActivity(api, pair.authors)).toEqual([]);
	} finally {
		await cleanupPair(api, pair);
	}
});

test('refuses a bulk delete when any item is referenced', async ({ api, vendor }) => {
	const pair = pairNames(`bulk_${vendor}_${randomUUID().slice(0, 8)}`);

	try {
		await createPair(api, pair, 'NO ACTION');

		const annId = await createItem(api, pair.authors, { name: 'Ann' });
		const bobId = await createItem(api, pair.authors, { name: 'Bob' });
		await createItem(api, pair.articles, { title: 'By Ann', author: annId });

		const authorsBefore = await rows(api, pair.authors);
		const articlesBefore = await rows(api, pair.articles);

		const res = await adminAuth(
			request(api.url)
				.delete(`/items/${pair.authors}`)
				.send({ keys: [annId, bobId] })
		);

		expect(res.statusCode).toBe(400);
		expect(res.body.errors[0].extensions.code).toBe('RECORD_STILL_REFERENCED');

		expect(await rows(api, pair.authors)).toEqual(authorsBefore);
		expect(await rows(api, pair.articles)).toEqual(articlesBefore);
		expect(await deleteActivity(api, pair.authors)).toEqual([]);
	} finally {
		await cleanupPair(api, pair);
	}
});

test('refuses a referenced delete through GraphQL', async ({ api, vendor }) => {
	const pair = pairNames(`gql_${vendor}_${randomUUID().slice(0, 8)}`);

	try {
		await createPair(api, pair, 'NO ACTION');

		const annId = await createItem(api, pair.authors, { name: 'Ann' });
		await createItem(api, pair.articles, { title: 'By Ann', author: annId });

		const authorsBefore = await rows(api, pair.authors);
		const articlesBefore = await rows(api, pair.articles);

		const res = await requestGraphQL(api.url, false, adminToken, {
			mutation: {
				[`delete_${pair.authors}_item`]: {
					__args: { id: annId },
					id: true,
				},
			},
		});

		expect(res.body.errors[0].message).toBe(`Item can't be deleted because other items still reference it.`);
		expect(await rows(api, pair.authors)).toEqual(authorsBefore);
		expect(await rows(api, pair.articles)).toEqual(articlesBefore);
	} finally {
		await cleanupPair(api, pair);
	}
});

test('gives a non-admin caller the same error without leaking the referencing collection', async ({ api, vendor }) => {
	const suffix = `restricted_${vendor}_${randomUUID().slice(0, 8)}`;
	const pair = pairNames(suffix);
	const token = `DelRefRestricted${suffix.replace(/[^a-zA-Z0-9]/g, '')}`;

	let roleId: string | undefined;
	let userId: string | undefined;

	try {
		await createPair(api, pair, 'NO ACTION');

		const annId = await createItem(api, pair.authors, { name: 'Ann' });
		await createItem(api, pair.articles, { title: 'By Ann', author: annId });

		const role = await CreateRole(api, {
			name: `del-ref-${suffix}`,
			appAccessEnabled: false,
			adminAccessEnabled: false,
		});

		roleId = role.id;

		const user = await adminAuth(
			setupRequest(api.url)
				.post('/users')
				.send({ email: `${suffix}@example.com`, password: randomUUID(), token, role: role.id })
		).expect(200);

		userId = user.body.data.id;

		for (const action of ['read', 'delete']) {
			await adminAuth(
				setupRequest(api.url)
					.post('/permissions')
					.send({ role: role.id, collection: pair.authors, action, fields: ['*'] })
			).expect(200);
		}

		const res = await request(api.url)
			.delete(`/items/${pair.authors}/${annId}`)
			.set('Authorization', `Bearer ${token}`);

		expect(res.statusCode).toBe(400);
		expect(res.body.errors[0].extensions.code).toBe('RECORD_STILL_REFERENCED');
		expect(res.text).not.toContain(pair.articles);

		expect(await rows(api, pair.authors)).toHaveLength(1);
	} finally {
		if (userId) await cleanupResource(api, `/users/${userId}`);
		if (roleId) await cleanupResource(api, `/roles/${roleId}`);
		await cleanupPair(api, pair);
	}
});

test('cascades a referenced delete when the relation is configured to cascade', async ({ api, vendor }) => {
	const pair = pairNames(`cascade_${vendor}_${randomUUID().slice(0, 8)}`);

	try {
		await createPair(api, pair, 'CASCADE');

		const annId = await createItem(api, pair.authors, { name: 'Ann' });
		await createItem(api, pair.articles, { title: 'By Ann', author: annId });

		const res = await adminAuth(request(api.url).delete(`/items/${pair.authors}/${annId}`));

		expect(res.statusCode).toBe(204);
		expect(await rows(api, pair.authors)).toHaveLength(0);
		expect(await rows(api, pair.articles)).toHaveLength(0);
	} finally {
		await cleanupPair(api, pair);
	}
});

test('nullifies a referenced delete when the relation is configured to set null', async ({ api, vendor }) => {
	const pair = pairNames(`setnull_${vendor}_${randomUUID().slice(0, 8)}`);

	try {
		await createPair(api, pair, 'SET NULL');

		const annId = await createItem(api, pair.authors, { name: 'Ann' });
		await createItem(api, pair.articles, { title: 'By Ann', author: annId });

		const res = await adminAuth(request(api.url).delete(`/items/${pair.authors}/${annId}`));

		expect(res.statusCode).toBe(204);
		expect(await rows(api, pair.authors)).toHaveLength(0);

		const articles = await rows(api, pair.articles);
		expect(articles).toHaveLength(1);
		expect(articles[0].author).toBeNull();
	} finally {
		await cleanupPair(api, pair);
	}
});

test('still rejects creating an item with an invalid foreign key', async ({ api, vendor }) => {
	const pair = pairNames(`create_${vendor}_${randomUUID().slice(0, 8)}`);

	try {
		await createPair(api, pair, 'NO ACTION');

		const res = await adminAuth(
			request(api.url).post(`/items/${pair.articles}`).send({ title: 'Orphan', author: 999999 })
		);

		expect(res.statusCode).toBe(400);
		expect(res.body.errors[0].extensions.code).toBe('INVALID_FOREIGN_KEY');
	} finally {
		await cleanupPair(api, pair);
	}
});
