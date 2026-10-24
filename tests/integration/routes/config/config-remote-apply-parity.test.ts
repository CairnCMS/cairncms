import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { sortBy } from 'lodash';
import path from 'path';
import type { Test } from 'supertest';
import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { apiTest as test } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { CreateCollection, CreateField } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

type Document = Record<string, any>;

function suffix(): string {
	return randomUUID().replace(/-/g, '').slice(0, 8);
}

function admin(api: Api, req: Test): Test {
	return req.set('Authorization', `Bearer ${api.adminToken}`);
}

async function createFolder(api: Api, key: string): Promise<string> {
	const response = await admin(api, request(api.url).post('/folders')).send({ name: key, key });
	expect(response.statusCode).toBe(200);
	return response.body.data.id;
}

async function snapshotConfig(api: Api, resources?: string[]): Promise<Document> {
	const query: Record<string, string> = { manifest_version: '3' };
	if (resources !== undefined) query['resources'] = resources.join(',');

	const response = await admin(api, request(api.url).get('/config/snapshot')).query(query);
	expect(response.statusCode).toBe(200);
	return response.body.data;
}

function applyTree(api: Api, desired: Document): Test {
	return admin(api, request(api.url).post('/config/apply')).set('Content-Type', 'application/json').send(desired);
}

async function folderByKey(api: Api, key: string): Promise<{ id: string; parent: string | null } | undefined> {
	return api.database('directus_folders').where({ key }).first();
}

async function reset(api: Api, collection: string, folderKeys: string[]): Promise<void> {
	const present =
		Boolean(await api.database('directus_collections').where({ collection }).first()) ||
		(await api.database.schema.hasTable(collection));

	if (present) {
		const deleted = await admin(api, request(api.url).delete(`/collections/${collection}`));
		expect([204, 403, 404]).toContain(deleted.statusCode);
	}

	await api.database('directus_fields').where({ collection }).delete();
	await api.database('directus_folders').whereIn('key', folderKeys).whereNotNull('parent').delete();
	await api.database('directus_folders').whereIn('key', folderKeys).delete();
}

async function assertAbsent(api: Api, collection: string, folderKeys: string[]): Promise<void> {
	expect(await api.database.schema.hasTable(collection)).toBe(false);
	expect(await api.database('directus_collections').where({ collection }).first()).toBeUndefined();

	for (const key of folderKeys) {
		expect(await folderByKey(api, key)).toBeUndefined();
	}
}

function normalizeSchemaAndFolders(snapshot: Document): Document {
	const schema = sortBy((snapshot['schema'] ?? []) as Document[], 'collection').map((collection) => ({
		...collection,
		fields: sortBy((collection['fields'] ?? []) as Document[], 'field'),
		relations: sortBy((collection['relations'] ?? []) as Document[], 'field'),
	}));

	return { schema, folders: sortBy((snapshot['folders'] ?? []) as Document[], 'key') };
}

describe('config apply surface parity between one HTTP request and the CLI', () => {
	test('one HTTP apply of a tree reaches the same target state as the CLI apply of the same tree', async ({ api }) => {
		const id = suffix();
		const collection = `parity_${id}`;
		const referenced = `parity_ref_${id}`;
		const unreferenced = `parity_un_${id}`;
		const folders = [referenced, unreferenced];
		const dir = await fs.mkdtemp(path.join(api.directory, 'config-parity-'));

		try {
			await CreateCollection(api, { collection });
			const referencedId = await createFolder(api, referenced);
			await createFolder(api, unreferenced);

			await CreateField(api, {
				collection,
				field: 'cover',
				type: 'uuid',
				meta: { interface: 'file', options: { folder: referencedId } },
			});

			const cliSnapshot = await api.cli(['config', 'snapshot', dir, '--yes']);
			expect(cliSnapshot.status, cliSnapshot.stderr).toBe(0);

			const desired = await snapshotConfig(api);

			await reset(api, collection, folders);
			await assertAbsent(api, collection, folders);

			const applied = await applyTree(api, desired);
			expect(applied.statusCode).toBe(200);
			expect(applied.body.meta.result).toBe('applied');

			expect(applied.body.meta.steps).toEqual({
				folders: 'committed',
				schema: 'committed',
				configuration: 'committed',
			});

			const httpState = normalizeSchemaAndFolders(await snapshotConfig(api, ['schema', 'folders']));

			expect(await folderByKey(api, referenced)).toBeDefined();
			expect(await folderByKey(api, unreferenced)).toBeDefined();
			expect(await api.database.schema.hasColumn(collection, 'cover')).toBe(true);

			await reset(api, collection, folders);
			await assertAbsent(api, collection, folders);

			const apply = await api.cli(['config', 'apply', dir, '--yes']);
			expect(apply.status, apply.stderr).toBe(0);

			const cliState = normalizeSchemaAndFolders(await snapshotConfig(api, ['schema', 'folders']));

			expect(httpState).toEqual(cliState);
		} finally {
			await reset(api, collection, folders);
		}
	});

	test('refuses a schema change the target cannot take before preparing folders, in a dry run and an apply', async ({
		api,
	}) => {
		const id = suffix();
		const collection = `parity_stop_${id}`;
		const referenced = `parity_stop_ref_${id}`;

		try {
			await CreateCollection(api, { collection });
			const referencedId = await createFolder(api, referenced);

			await CreateField(api, {
				collection,
				field: 'cover',
				type: 'uuid',
				meta: { interface: 'file', options: { folder: referencedId } },
			});

			await CreateField(api, { collection, field: 'title', type: 'string' });
			await api.database(collection).insert({ title: 'kept' });

			const desired = await snapshotConfig(api, ['schema', 'folders']);

			await admin(api, request(api.url).delete(`/fields/${collection}/cover`)).expect(204);
			await admin(api, request(api.url).delete(`/folders/${referencedId}`)).expect(204);

			const target = (desired['schema'] as Document[]).find((entry) => entry['collection'] === collection)!;
			const title = (target['fields'] as Document[]).find((entry) => entry['field'] === 'title')!;
			delete title['schema'];

			const dryRun = await admin(api, request(api.url).post('/config/apply').query({ dry_run: 'true' }))
				.set('Content-Type', 'application/json')
				.send(desired);

			for (const response of [dryRun, await applyTree(api, desired)]) {
				expect(response.statusCode).toBe(400);

				const [error] = response.body.errors;
				expect(error.extensions.code).toBe('CONFIG_INVALID');
				expect(error.message).toContain('remain as a field');
				expect(error.extensions.steps).toEqual({ folders: 'not_run', schema: 'not_run', configuration: 'not_run' });
				expect(error.extensions).not.toHaveProperty('failure');
			}

			expect(await folderByKey(api, referenced)).toBeUndefined();
			expect(await api.database.schema.hasColumn(collection, 'cover')).toBe(false);
			expect(await api.database(collection).select('title')).toEqual([{ title: 'kept' }]);
		} finally {
			await reset(api, collection, [referenced]);
		}
	});
});
