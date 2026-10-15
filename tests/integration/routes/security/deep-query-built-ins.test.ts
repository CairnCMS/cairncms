import { describe, expect } from 'vitest';
import * as common from '../../common/functions';
import type { Api } from '../../fixtures/environment';
import request, { setupRequest } from '../../fixtures/request';
import { createScenarioTest } from '../../fixtures/scenario';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const adminToken = common.USER.ADMIN!.TOKEN;
const authorsCollection = 'test_deep_built_ins_authors';
const booksCollection = 'test_deep_built_ins_books';
const importerRoleName = 'deep_built_ins_importer';
const importerToken = 'DeepBuiltInsImporterToken';
const importerEmail = 'deep-built-ins-importer@example.com';
const seededName = 'seeded-author';
const craftedDeep = { toString: { call: { _limit: 1 } } };

const authorIds = {} as { [vendor: string]: number };
const roleIds = {} as { [vendor: string]: string };
const userIds = {} as { [vendor: string]: string };

async function deleteResource(api: Api, vendor: string, resource: string, failures: string[]) {
	try {
		const response = await request(api.url).delete(resource).set('Authorization', `Bearer ${adminToken}`);

		if (response.statusCode >= 400 && response.statusCode !== 404) {
			failures.push(`DELETE ${resource} on ${vendor} returned ${response.statusCode}`);
		}
	} catch (error) {
		failures.push(`DELETE ${resource} on ${vendor} threw ${String(error)}`);
	}
}

const test = createScenarioTest({
	prepare: async (api, vendor) => {
		await common.CreateCollection(api, { collection: authorsCollection });
		await common.CreateCollection(api, { collection: booksCollection });
		await common.CreateField(api, { collection: authorsCollection, field: 'name', type: 'string' });
		await common.CreateField(api, { collection: authorsCollection, field: 'details', type: 'json' });
		await common.CreateField(api, { collection: booksCollection, field: 'title', type: 'string' });

		await common.CreateFieldO2M(api, {
			collection: authorsCollection,
			field: 'books',
			otherCollection: booksCollection,
			otherField: 'author',
		});

		const author = await common.CreateItem(api, { collection: authorsCollection, item: { name: seededName } });
		authorIds[vendor] = author.id;

		await common.CreateItem(api, {
			collection: booksCollection,
			item: [
				{ title: 'first', author: author.id },
				{ title: 'second', author: author.id },
			],
		});

		const role = await common.CreateRole(api, {
			name: importerRoleName,
			appAccessEnabled: false,
			adminAccessEnabled: false,
		});

		roleIds[vendor] = role.id;

		const user = await common.CreateUser(api, { token: importerToken, email: importerEmail, role: role.id });
		userIds[vendor] = user.id;

		for (const action of ['create', 'update']) {
			await setupRequest(api.url)
				.post('/permissions')
				.set('Authorization', `Bearer ${adminToken}`)
				.send({ role: role.id, collection: authorsCollection, action, fields: ['*'] })
				.expect(200);
		}
	},
	cleanup: async (api, vendor) => {
		const failures: string[] = [];

		if (userIds[vendor]) await deleteResource(api, vendor, `/users/${userIds[vendor]}`, failures);
		if (roleIds[vendor]) await deleteResource(api, vendor, `/roles/${roleIds[vendor]}`, failures);

		for (const collection of [booksCollection, authorsCollection]) {
			await deleteResource(api, vendor, `/collections/${collection}`, failures);
		}

		if (failures.length) throw new Error('Deep query built-ins teardown failures: ' + failures.join('; '));
	},
});

async function withCompanion(api: Api, run: (url: string) => Promise<void>) {
	const companion = await api.start();

	try {
		await run(companion.url);
	} finally {
		await api.stop(companion.child);
	}
}

async function expectServing(url: string, vendor: string) {
	const health = await request(url).get('/server/health');
	expect(health.statusCode).toBe(200);

	const read = await request(url)
		.get(`/items/${authorsCollection}/${authorIds[vendor]}`)
		.query({ fields: ['name'] })
		.set('Authorization', `Bearer ${adminToken}`);

	expect(read.statusCode).toBe(200);
	expect(read.body.data).toEqual({ name: seededName });
}

async function importCsv(url: string, token: string, csv: string) {
	return await request(url)
		.post(`/utils/import/${authorsCollection}`)
		.set('Authorization', `Bearer ${token}`)
		.attach('file', Buffer.from(csv), { filename: 'authors.csv', contentType: 'text/csv' });
}

async function readAuthorByName(url: string, name: string) {
	const response = await request(url)
		.get(`/items/${authorsCollection}`)
		.query({ filter: { name: { _eq: name } }, fields: ['name', 'details'] })
		.set('Authorization', `Bearer ${adminToken}`);

	expect(response.statusCode).toBe(200);

	return response.body.data;
}

describe('query keys naming built-in properties', () => {
	test('an unauthenticated GET with a JSON string deep leaves the process serving', async ({ api, vendor }) => {
		await withCompanion(api, async (url) => {
			await expectServing(url, vendor);

			const response = await request(url)
				.get(`/items/${authorsCollection}`)
				.query({ deep: JSON.stringify(craftedDeep) });

			await expectServing(url, vendor);
			expect(response.statusCode).toBe(403);
		});
	});

	test('a SEARCH body deep is kept as inert data and leaves the process serving', async ({ api, vendor }) => {
		await withCompanion(api, async (url) => {
			await expectServing(url, vendor);

			const response = await request(url)
				.search(`/items/${authorsCollection}`)
				.set('Authorization', `Bearer ${adminToken}`)
				.send({
					query: { fields: ['id', 'name'], filter: { id: { _eq: authorIds[vendor] } }, deep: craftedDeep },
				});

			await expectServing(url, vendor);
			expect(response.statusCode).toBe(200);
			expect(response.body.data).toEqual([{ id: authorIds[vendor], name: seededName }]);
		});
	});

	test('a CSV import with a built-in header imports the row and leaves the process serving', async ({
		api,
		vendor,
	}) => {
		await withCompanion(api, async (url) => {
			await expectServing(url, vendor);

			const response = await importCsv(url, importerToken, 'name,toString.call\nimported-author,value\n');

			await expectServing(url, vendor);
			expect(response.statusCode).toBe(200);
		});

		expect(await readAuthorByName(api.url, 'imported-author')).toEqual([{ name: 'imported-author', details: null }]);
	});

	test('an ordinary relational deep query returns the limited nested rows', async ({ api, vendor }) => {
		const response = await request(api.url)
			.get(`/items/${authorsCollection}/${authorIds[vendor]}`)
			.query({ fields: ['books.title'], deep: JSON.stringify({ books: { _sort: ['title'], _limit: 1 } }) })
			.set('Authorization', `Bearer ${adminToken}`);

		expect(response.statusCode).toBe(200);
		expect(response.body.data).toEqual({ books: [{ title: 'first' }] });
	});

	test('a CSV import with a dotted header saves the nested JSON value', async ({ api }) => {
		const response = await importCsv(api.url, adminToken, 'name,details.color\ndotted-author,blue\n');

		expect(response.statusCode).toBe(200);

		expect(await readAuthorByName(api.url, 'dotted-author')).toEqual([
			{ name: 'dotted-author', details: { color: 'blue' } },
		]);
	});
});
