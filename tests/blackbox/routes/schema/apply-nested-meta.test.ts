import { getUrl } from '@common/config';
import { CreateCollection } from '@common/functions';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { cloneDeep } from 'lodash';
import request from 'supertest';

const TEST_TIMEOUT = 300000;

type CollectionTranslation = { language: string; translation: string; singular?: string; plural?: string };
type CollectionMetaFixture = { note?: string; translations: CollectionTranslation[] };

const adminAuth = (req: request.Test) => req.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

function baseMeta(): CollectionMetaFixture {
	return {
		note: 'original note',
		translations: [{ language: 'en-US', translation: 'Article', singular: 'article', plural: 'articles' }],
	};
}

function metaWithoutPlural(): CollectionMetaFixture {
	return {
		note: 'original note',
		translations: [{ language: 'en-US', translation: 'Article', singular: 'article' }],
	};
}

async function seedCollection(vendor: string, collection: string, meta: CollectionMetaFixture) {
	const created = await CreateCollection(vendor, {
		collection,
		meta,
		fields: [{ field: 'title', type: 'string', meta: {}, schema: {} }],
	});

	expect(created?.collection).toBe(collection);

	for (const title of ['first', 'second']) {
		const res = await adminAuth(request(getUrl(vendor)).post(`/items/${collection}`)).send({ title });
		expect(res.statusCode).toBe(200);
	}
}

async function deleteCollection(vendor: string, collection: string) {
	const res = await adminAuth(request(getUrl(vendor)).delete(`/collections/${collection}`));
	expect([204, 403]).toContain(res.statusCode);
}

async function getCollectionMeta(vendor: string, collection: string) {
	const res = await adminAuth(request(getUrl(vendor)).get(`/collections/${collection}`));
	expect(res.statusCode).toBe(200);
	return res.body.data?.meta;
}

async function getRowTitles(vendor: string, collection: string) {
	const res = await adminAuth(request(getUrl(vendor)).get(`/items/${collection}`)).query({ limit: -1 });
	expect(res.statusCode).toBe(200);
	return (res.body.data as Array<{ title: string }>).map((row) => row.title).sort();
}

async function snapshotEditApply(vendor: string, edit: (snapshot: any) => void) {
	const snapshotRes = await adminAuth(request(getUrl(vendor)).get('/schema/snapshot'));
	expect(snapshotRes.statusCode).toBe(200);

	const edited = cloneDeep(snapshotRes.body.data);
	edit(edited);

	const diffRes = await adminAuth(
		request(getUrl(vendor)).post('/schema/diff').send(edited).set('Content-type', 'application/json')
	);

	expect(diffRes.statusCode).toBe(200);

	const applyRes = await adminAuth(
		request(getUrl(vendor)).post('/schema/apply').send(diffRes.body.data).set('Content-type', 'application/json')
	);

	return { applyStatus: applyRes.statusCode, diff: diffRes.body.data?.diff };
}

const findCollection = (snapshot: any, collection: string) =>
	snapshot.collections.find((c: any) => c.collection === collection);

const collectionDiffEntry = (diff: any, collection: string) =>
	diff?.collections?.find((c: any) => c.collection === collection)?.diff?.[0];

describe('Schema apply: nested collection meta diffs', () => {
	describe('a nested meta delete leaves the collection and its rows intact and applies the change', () => {
		it.each(vendors)(
			'%s',
			async (vendor) => {
				const collection = `test_apply_nm_delete_${vendor}`;
				await deleteCollection(vendor, collection);

				try {
					await seedCollection(vendor, collection, baseMeta());

					const result = await snapshotEditApply(vendor, (snapshot) => {
						const target = findCollection(snapshot, collection);
						delete target.meta.translations[0].plural;
					});

					const entry = collectionDiffEntry(result.diff, collection);
					expect(entry?.kind).toBe('D');
					expect(entry?.path).toEqual(['meta', 'translations', 0, 'plural']);

					expect(result.applyStatus).toBe(204);
					expect(await getRowTitles(vendor, collection)).toEqual(['first', 'second']);

					const meta = await getCollectionMeta(vendor, collection);
					expect(meta.translations[0].plural).toBeUndefined();
					expect(meta.translations[0].singular).toBe('article');
				} finally {
					await deleteCollection(vendor, collection);
				}
			},
			TEST_TIMEOUT
		);
	});

	describe('a nested meta create succeeds where it used to hard-fail the whole apply', () => {
		it.each(vendors)(
			'%s',
			async (vendor) => {
				const collection = `test_apply_nm_create_${vendor}`;
				await deleteCollection(vendor, collection);

				try {
					await seedCollection(vendor, collection, metaWithoutPlural());

					const result = await snapshotEditApply(vendor, (snapshot) => {
						const target = findCollection(snapshot, collection);
						target.meta.translations[0].plural = 'articles';
					});

					const entry = collectionDiffEntry(result.diff, collection);
					expect(entry?.kind).toBe('N');
					expect(entry?.path).toEqual(['meta', 'translations', 0, 'plural']);

					expect(result.applyStatus).toBe(204);
					expect(await getRowTitles(vendor, collection)).toEqual(['first', 'second']);

					const meta = await getCollectionMeta(vendor, collection);
					expect(meta.translations[0].plural).toBe('articles');
					expect(meta.translations[0].singular).toBe('article');
				} finally {
					await deleteCollection(vendor, collection);
				}
			},
			TEST_TIMEOUT
		);
	});

	describe('a top-level meta delete is safe (collection and rows survive)', () => {
		it.each(vendors)(
			'%s',
			async (vendor) => {
				const collection = `test_apply_nm_note_${vendor}`;
				await deleteCollection(vendor, collection);

				try {
					await seedCollection(vendor, collection, baseMeta());

					const result = await snapshotEditApply(vendor, (snapshot) => {
						const target = findCollection(snapshot, collection);
						delete target.meta.note;
					});

					const entry = collectionDiffEntry(result.diff, collection);
					expect(entry?.kind).toBe('D');
					expect(entry?.path).toEqual(['meta', 'note']);

					// A top-level meta delete is a partial update that does not converge, so this asserts
					// data safety only, not that note was removed.
					expect(result.applyStatus).toBe(204);
					expect(await getRowTitles(vendor, collection)).toEqual(['first', 'second']);
				} finally {
					await deleteCollection(vendor, collection);
				}
			},
			TEST_TIMEOUT
		);
	});

	describe('a nested meta delete does not suppress a real field change on the same collection', () => {
		it.each(vendors)(
			'%s',
			async (vendor) => {
				const collection = `test_apply_nm_suppress_${vendor}`;
				await deleteCollection(vendor, collection);

				try {
					await seedCollection(vendor, collection, baseMeta());

					const result = await snapshotEditApply(vendor, (snapshot) => {
						const target = findCollection(snapshot, collection);
						delete target.meta.translations[0].plural;

						snapshot.fields.push({
							collection,
							field: 'subtitle',
							type: 'string',
							meta: { collection, field: 'subtitle', interface: 'input' },
							schema: { name: 'subtitle', table: collection, data_type: 'varchar' },
						});
					});

					const entry = collectionDiffEntry(result.diff, collection);
					expect(entry?.kind).toBe('D');
					expect(entry?.path).toEqual(['meta', 'translations', 0, 'plural']);

					const fieldEntry = result.diff.fields.find((f: any) => f.collection === collection && f.field === 'subtitle');

					expect(fieldEntry?.diff?.[0]?.kind).toBe('N');

					expect(result.applyStatus).toBe(204);

					const fieldRes = await adminAuth(request(getUrl(vendor)).get(`/fields/${collection}/subtitle`));
					expect(fieldRes.statusCode).toBe(200);
				} finally {
					await deleteCollection(vendor, collection);
				}
			},
			TEST_TIMEOUT
		);
	});

	describe('a genuine whole-collection delete still deletes it', () => {
		it.each(vendors)(
			'%s',
			async (vendor) => {
				const collection = `test_apply_nm_realdelete_${vendor}`;
				await deleteCollection(vendor, collection);

				try {
					await seedCollection(vendor, collection, baseMeta());

					const result = await snapshotEditApply(vendor, (snapshot) => {
						snapshot.collections = snapshot.collections.filter((c: any) => c.collection !== collection);
						snapshot.fields = snapshot.fields.filter((f: any) => f.collection !== collection);
					});

					const entry = collectionDiffEntry(result.diff, collection);
					expect(entry?.kind).toBe('D');
					expect(entry?.path).toBeUndefined();

					expect(result.applyStatus).toBe(204);

					const stillThere = await adminAuth(request(getUrl(vendor)).get(`/collections/${collection}`));
					expect(stillThere.statusCode).toBe(403);
				} finally {
					await deleteCollection(vendor, collection);
				}
			},
			TEST_TIMEOUT
		);
	});
});
