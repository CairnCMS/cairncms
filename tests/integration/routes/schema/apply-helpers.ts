import { randomUUID } from 'crypto';
import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import request, { setupRequest } from '../../fixtures/request';

export type Snapshot = {
	collections: Array<{ collection: string; [key: string]: unknown }>;
	fields: Array<{ collection: string; [key: string]: unknown }>;
	relations: Array<{ collection: string; related_collection: string | null }>;
};

export function suffix(): string {
	return randomUUID().replace(/-/g, '').slice(0, 10);
}

export async function createFolder(api: Api, collection: string): Promise<void> {
	await setupRequest(api.url)
		.post('/collections')
		.auth(api.adminToken, { type: 'bearer' })
		.send({ collection, meta: {}, schema: null })
		.expect(200);
}

export async function clearCache(api: Api): Promise<void> {
	await setupRequest(api.url).post('/utils/cache/clear').auth(api.adminToken, { type: 'bearer' }).expect(200);
}

export async function snapshotWithout(api: Api, dropped: string[]): Promise<Snapshot> {
	const response = await setupRequest(api.url).get('/schema/snapshot').auth(api.adminToken, { type: 'bearer' });
	expect(response.statusCode).toBe(200);

	const snapshot = response.body.data as Snapshot;
	const names = snapshot.collections.map((entry) => entry.collection);

	for (const collection of dropped) expect(names).toContain(collection);

	return {
		...snapshot,
		collections: snapshot.collections.filter((entry) => !dropped.includes(entry.collection)),
		fields: snapshot.fields.filter((entry) => !dropped.includes(entry.collection)),
		relations: snapshot.relations.filter(
			(entry) => !dropped.includes(entry.collection) && !dropped.includes(entry.related_collection ?? '')
		),
	};
}

export async function diffThenApply(api: Api, desired: Snapshot) {
	const diff = await setupRequest(api.url)
		.post('/schema/diff')
		.auth(api.adminToken, { type: 'bearer' })
		.send(desired)
		.set('Content-type', 'application/json');

	expect(diff.statusCode).toBe(200);

	return request(api.url)
		.post('/schema/apply')
		.auth(api.adminToken, { type: 'bearer' })
		.send(diff.body.data)
		.set('Content-type', 'application/json');
}

export async function schemaDiffStatus(api: Api, desired: Snapshot): Promise<number> {
	const diff = await setupRequest(api.url)
		.post('/schema/diff')
		.auth(api.adminToken, { type: 'bearer' })
		.send(desired)
		.set('Content-type', 'application/json');

	return diff.statusCode;
}

export async function applyIfChanged(api: Api, desired: Snapshot) {
	const diff = await setupRequest(api.url)
		.post('/schema/diff')
		.auth(api.adminToken, { type: 'bearer' })
		.send(desired)
		.set('Content-type', 'application/json');

	if (diff.statusCode === 204) return diff;

	expect(diff.statusCode).toBe(200);

	return request(api.url)
		.post('/schema/apply')
		.auth(api.adminToken, { type: 'bearer' })
		.send(diff.body.data)
		.set('Content-type', 'application/json');
}

export async function expectCollectionGone(api: Api, collection: string): Promise<void> {
	expect(await api.database.schema.hasTable(collection)).toBe(false);
	expect(await api.database('directus_collections').where({ collection })).toEqual([]);
	expect(await api.database('directus_fields').where({ collection })).toEqual([]);
	expect(await api.database('directus_permissions').where({ collection })).toEqual([]);
}

export async function removeCollections(api: Api, collections: string[]): Promise<void> {
	for (const collection of collections) {
		const meta = await api.database('directus_collections').where({ collection }).first();

		if (meta !== undefined || (await api.database.schema.hasTable(collection))) {
			const response = await request(api.url)
				.delete(`/collections/${collection}`)
				.auth(api.adminToken, { type: 'bearer' });

			expect([204, 403]).toContain(response.statusCode);
		}

		await api.database.schema.dropTableIfExists(collection);
		await api.database('directus_fields').where({ collection }).delete();
		await api.database('directus_permissions').where({ collection }).delete();
		await api.database('directus_collections').where({ collection }).delete();
	}

	await clearCache(api);
}
