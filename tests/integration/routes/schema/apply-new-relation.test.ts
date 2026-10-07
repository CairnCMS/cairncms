import { describe, expect } from 'vitest';
import type { Test } from 'supertest';
import type { Api } from '../../fixtures/environment';
import { identityTest as test } from '../../fixtures/identities';
import { CreateCollection, CreateFieldM2O } from '../../fixtures/data';
import * as common from '../../fixtures/data';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const TEST_TIMEOUT = 300000;

const adminAuth = (req: Test) => req.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

async function deleteCollection(api: Api, collection: string) {
	const res = await adminAuth(request(api.url).delete(`/collections/${collection}`));
	expect([204, 403]).toContain(res.statusCode);
}

describe('Schema apply: new relations', () => {
	describe('creates a relation whose identifiers appear only on the diff entry', () => {
		test(
			'REST',
			async ({ api, vendor }) => {
				const authors = `test_apply_rel_authors_${vendor}`;
				const articles = `test_apply_rel_articles_${vendor}`;

				await deleteCollection(api, articles);
				await deleteCollection(api, authors);

				try {
					await CreateCollection(api, { collection: authors });
					await CreateCollection(api, { collection: articles });
					await CreateFieldM2O(api, { collection: articles, field: 'author', otherCollection: authors });

					const snapshotRes = await adminAuth(request(api.url).get('/schema/snapshot'));
					expect(snapshotRes.statusCode).toBe(200);

					const deleteRes = await adminAuth(request(api.url).delete(`/relations/${articles}/author`));
					expect(deleteRes.statusCode).toBe(204);

					const diffRes = await adminAuth(
						request(api.url).post('/schema/diff').send(snapshotRes.body.data).set('Content-type', 'application/json')
					);

					expect(diffRes.statusCode).toBe(200);

					const entry = diffRes.body.data.diff.relations.find(
						(relation: any) => relation.collection === articles && relation.field === 'author'
					);

					expect(entry?.diff?.[0]?.kind).toBe('N');

					delete entry.diff[0].rhs.collection;
					delete entry.diff[0].rhs.field;

					const applyRes = await adminAuth(
						request(api.url).post('/schema/apply').send(diffRes.body.data).set('Content-type', 'application/json')
					);

					expect(applyRes.statusCode).toBe(204);

					const relationRes = await adminAuth(request(api.url).get(`/relations/${articles}/author`));
					expect(relationRes.statusCode).toBe(200);
					expect(relationRes.body.data.related_collection).toBe(authors);
					expect(relationRes.body.data.schema?.foreign_key_table).toBe(authors);
				} finally {
					await deleteCollection(api, articles);
					await deleteCollection(api, authors);
				}
			},
			TEST_TIMEOUT
		);
	});
});
