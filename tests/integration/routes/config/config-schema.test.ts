import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import path from 'path';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { apiTest as test, type Api } from '../../fixtures/environment';
import request, { setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

type Document = Record<string, any>;
type Change = { kind: string; operation: string; identity: Record<string, string>; [key: string]: unknown };

const SCOPE = ['permissions', 'schema'];

async function snapshot(api: Api, version: number, resources?: string[]): Promise<Document> {
	const response = await request(api.url)
		.get('/config/snapshot')
		.query({ manifest_version: String(version), ...(resources && { resources: resources.join(',') }) })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);
	return response.body.data;
}

function applyConfig(api: Api, desired: Document, options: { dryRun?: boolean } = {}) {
	const req = request(api.url)
		.post('/config/apply')
		.set('Authorization', `Bearer ${api.adminToken}`)
		.set('Content-Type', 'application/json');

	if (options.dryRun) req.query({ dry_run: 'true' });

	return req.send(desired);
}

async function createCollection(api: Api, collection: string, fields: Array<[string, string]>): Promise<void> {
	await setupRequest(api.url)
		.post('/collections')
		.auth(api.adminToken, { type: 'bearer' })
		.send({
			collection,
			meta: {},
			schema: {},
			fields: [
				{
					field: 'id',
					type: 'integer',
					meta: { hidden: true },
					schema: { is_primary_key: true, has_auto_increment: true },
				},
				...fields.map(([field, type]) => ({ field, type, meta: {}, schema: {} })),
			],
		})
		.expect(200);
}

async function dropCollection(api: Api, collection: string): Promise<void> {
	const meta = await api.database('directus_collections').where({ collection }).first();

	if (meta !== undefined || (await api.database.schema.hasTable(collection))) {
		await setupRequest(api.url)
			.delete(`/collections/${collection}`)
			.auth(api.adminToken, { type: 'bearer' })
			.expect(204);
	}

	await api.database('directus_fields').where({ collection }).delete();
	await api.database('directus_permissions').where({ collection }).delete();
}

async function clearCache(api: Api): Promise<void> {
	await setupRequest(api.url).post('/utils/cache/clear').auth(api.adminToken, { type: 'bearer' }).expect(200);
}

async function captureState(api: Api, collections: string[], role?: string): Promise<Document> {
	const db = api.database;
	const tables: Record<string, unknown> = {};

	for (const collection of collections) {
		tables[collection] = (await db.schema.hasTable(collection)) ? await db(collection).columnInfo() : null;
	}

	return {
		tables,
		collections: await db('directus_collections').whereIn('collection', collections).orderBy('collection'),
		fields: await db('directus_fields').whereIn('collection', collections).orderBy('id'),
		relations: await db('directus_relations')
			.whereIn('many_collection', collections)
			.orWhereIn('one_collection', collections)
			.orderBy('id'),
		permissions: await db('directus_permissions')
			.whereIn('collection', collections)
			.modify((query) => {
				if (role !== undefined) query.orWhere({ role });
			})
			.orderBy('id'),
	};
}

async function createRole(api: Api, key: string): Promise<string> {
	const response = await setupRequest(api.url)
		.post('/roles')
		.auth(api.adminToken, { type: 'bearer' })
		.send({ key, name: key, app_access: true, admin_access: false })
		.expect(200);

	return response.body.data.id;
}

async function deleteRole(api: Api, id: string | undefined): Promise<void> {
	if (id === undefined) return;
	await setupRequest(api.url).delete(`/roles/${id}`).auth(api.adminToken, { type: 'bearer' }).expect(204);
}

async function grantRead(api: Api, role: string, collection: string, fields: string[]): Promise<void> {
	await setupRequest(api.url)
		.post('/permissions')
		.auth(api.adminToken, { type: 'bearer' })
		.send({ role, collection, action: 'read', fields })
		.expect(200);
}

function newCollection(collection: string): Document {
	return {
		collection,
		meta: null,
		schema: { name: collection },
		fields: [
			{
				collection,
				field: 'id',
				type: 'integer',
				meta: null,
				schema: {
					name: 'id',
					table: collection,
					data_type: 'integer',
					is_nullable: false,
					is_primary_key: true,
					has_auto_increment: true,
				},
			},
		],
		relations: [],
	};
}

function readPermission(collection: string, fields: string[]): Document {
	return { collection, action: 'read', permissions: null, validation: null, presets: null, fields };
}

function changesOf(document: Document, kinds: string[]): Change[] {
	return (document['changes'] as Change[]).filter((change) => kinds.includes(change.kind));
}

describe('config apply previews a version 3 schema tree', () => {
	let fixtureRoot: string;

	beforeEach(async ({ api }: { api: Api }) => {
		fixtureRoot = await fs.mkdtemp(path.join(api.directory, 'cairncms-config-schema-'));
	});

	afterEach(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true });
	});

	async function snapshotTree(api: Api, resources: string[]): Promise<void> {
		await fs.writeFile(path.join(fixtureRoot, 'cairncms-config.yaml'), dumpYaml({ version: 3, resources }));

		const result = await api.cli(['config', 'snapshot', fixtureRoot, '--yes']);

		expect(result.status).toBe(0);
	}

	function treeFile(kind: string, stem: string): string {
		return path.join(fixtureRoot, kind, `${stem}.yaml`);
	}

	async function readTreeFile(kind: string, stem: string): Promise<Document> {
		return loadYaml(await fs.readFile(treeFile(kind, stem), 'utf8')) as Document;
	}

	async function writeTreeFile(kind: string, stem: string, document: Document): Promise<void> {
		await fs.writeFile(treeFile(kind, stem), dumpYaml(document));
	}

	test('plans schema changes and the configuration they leave, the same over HTTP and the CLI', async ({ api }) => {
		const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
		const legacy = `preview_legacy_${suffix}`;
		const articles = `preview_articles_${suffix}`;
		const created = `preview_created_${suffix}`;
		const roleKey = `preview_editor_${suffix}`;
		let roleId: string | undefined;

		try {
			await createCollection(api, legacy, [['title', 'string']]);

			await createCollection(api, articles, [
				['title', 'string'],
				['body', 'text'],
			]);

			roleId = await createRole(api, roleKey);
			await grantRead(api, roleId, legacy, ['title']);
			await grantRead(api, roleId, articles, ['title', 'body']);

			await snapshotTree(api, SCOPE);

			await fs.rm(treeFile('schema', legacy));

			const articlesFile = await readTreeFile('schema', articles);

			articlesFile['fields'] = (articlesFile['fields'] as Document[]).filter((field) => field['field'] !== 'body');
			await writeTreeFile('schema', articles, articlesFile);
			await writeTreeFile('schema', created, newCollection(created));

			const permissionsFile = await readTreeFile('permissions', roleKey);
			permissionsFile['permissions'].push(readPermission(created, ['id']));
			await writeTreeFile('permissions', roleKey, permissionsFile);

			const desired = await snapshot(api, 3, SCOPE);

			desired['schema'] = (desired['schema'] as Document[]).filter((record) => record['collection'] !== legacy);

			const articlesRecord = (desired['schema'] as Document[]).find((record) => record['collection'] === articles)!;
			articlesRecord['fields'] = articlesRecord['fields'].filter((field: Document) => field['field'] !== 'body');
			desired['schema'].push(newCollection(created));

			const roleSet = (desired['permissions'] as Document[]).find((set) => set['role'] === roleKey)!;
			roleSet['permissions'].push(readPermission(created, ['id']));

			const before = await captureState(api, [legacy, articles, created], roleId);

			expect(before['tables']).toEqual({
				[legacy]: expect.any(Object),
				[articles]: expect.any(Object),
				[created]: null,
			});

			expect(before['permissions']).toHaveLength(2);

			const http = await applyConfig(api, desired, { dryRun: true });

			expect(http.statusCode).toBe(200);
			expect(await captureState(api, [legacy, articles, created], roleId)).toEqual(before);

			const plan = http.body.data as Document;

			expect(plan['planVersion']).toBe(3);

			const schemaChanges = changesOf(plan, ['collections', 'fields', 'relations']).map(
				({ kind, operation, identity }) => ({ kind, operation, identity })
			);

			expect(schemaChanges).toEqual(
				expect.arrayContaining([
					{ kind: 'collections', operation: 'delete', identity: { collection: legacy } },
					{ kind: 'fields', operation: 'delete', identity: { collection: articles, field: 'body' } },
					{ kind: 'collections', operation: 'create', identity: { collection: created } },
					{ kind: 'fields', operation: 'create', identity: { collection: created, field: 'id' } },
				])
			);

			const permissionChanges = changesOf(plan, ['permissions']).filter(
				(change) => change.identity['role'] === roleKey
			);

			expect(permissionChanges).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						operation: 'create',
						identity: { role: roleKey, collection: legacy, action: 'read' },
					}),
					expect.objectContaining({
						operation: 'create',
						identity: { role: roleKey, collection: created, action: 'read' },
					}),
					{
						kind: 'permissions',
						operation: 'update',
						identity: { role: roleKey, collection: articles, action: 'read' },
						fields: { fields: { before: ['title'], after: ['body', 'title'] } },
					},
				])
			);

			expect(permissionChanges).toHaveLength(3);

			const missing = (plan['warnings'] as Document[])
				.filter((warning) => warning['code'] === 'COLLECTION_MISSING')
				.map((warning) => warning['identity']['collection']);

			expect(missing).toContain(legacy);
			expect(missing).not.toContain(created);
			expect(missing).not.toContain(articles);

			const cli = await api.cli(['config', 'apply', fixtureRoot, '--dry-run', '--format', 'json']);

			expect(cli.status).toBe(1);
			expect(JSON.parse(cli.stdout)).toEqual(plan);
			expect(await captureState(api, [legacy, articles, created], roleId)).toEqual(before);
		} finally {
			await dropCollection(api, legacy);
			await dropCollection(api, articles);
			await dropCollection(api, created);
			await deleteRole(api, roleId);
		}
	});

	test('refuses a mutating apply with schema changes and writes nothing, over HTTP and the CLI', async ({ api }) => {
		const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
		const created = `preview_refused_${suffix}`;

		try {
			await snapshotTree(api, ['schema']);
			await writeTreeFile('schema', created, newCollection(created));

			const desired = await snapshot(api, 3, ['schema']);
			desired['schema'].push(newCollection(created));

			const before = await captureState(api, [created]);

			expect(before).toEqual({
				tables: { [created]: null },
				collections: [],
				fields: [],
				relations: [],
				permissions: [],
			});

			const http = await applyConfig(api, desired);

			expect(http.statusCode).toBe(500);
			expect(http.body.errors[0].extensions.code).toBe('CONFIG_APPLY_FAILED');
			expect(await captureState(api, [created])).toEqual(before);

			const cli = await api.cli(['config', 'apply', fixtureRoot, '--yes']);

			expect(cli.status).toBe(3);
			expect(await captureState(api, [created])).toEqual(before);
		} finally {
			await dropCollection(api, created);
		}
	});

	test('snapshots a folder to a file without a schema, and plans the tree without schema changes', async ({ api }) => {
		const folder = `preview_folder_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

		try {
			await setupRequest(api.url)
				.post('/collections')
				.auth(api.adminToken, { type: 'bearer' })
				.send({ collection: folder, meta: {}, schema: null })
				.expect(200);

			await snapshotTree(api, ['schema']);

			const file = await readTreeFile('schema', folder);

			expect(file['meta']).toMatchObject({ collection: folder });
			expect(file).not.toHaveProperty('schema');

			const http = await applyConfig(api, await snapshot(api, 3, ['schema']), { dryRun: true });

			expect(http.statusCode).toBe(200);
			expect(changesOf(http.body.data, ['collections', 'fields', 'relations'])).toEqual([]);

			const cli = await api.cli(['config', 'apply', fixtureRoot, '--dry-run', '--format', 'json']);

			expect(JSON.parse(cli.stdout)).toEqual(http.body.data);
		} finally {
			await dropCollection(api, folder);
		}
	});

	test('refuses a collection file without meta, and plans no schema changes once its null meta is restored', async ({
		api,
	}) => {
		const table = `preview_unconfigured_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
		const refusal = `Schema collection "${table}" must declare "meta", which can be null.`;

		try {
			await api.database.schema.createTable(table, (builder) => {
				builder.increments('id');
				builder.string('title');
			});

			await api.database(table).insert({ title: 'kept' });
			await clearCache(api);

			await snapshotTree(api, ['schema']);

			const file = await readTreeFile('schema', table);
			expect(file['meta']).toBeNull();
			delete file['meta'];
			await writeTreeFile('schema', table, file);

			const desired = await snapshot(api, 3, ['schema']);
			const record = (desired['schema'] as Document[]).find((entry) => entry['collection'] === table)!;
			delete record['meta'];

			const before = await captureState(api, [table]);
			const rows = await api.database(table).select('id', 'title');

			expect(before['tables']).toEqual({ [table]: expect.any(Object) });
			expect(before['collections']).toEqual([]);
			expect(rows).toEqual([{ id: 1, title: 'kept' }]);

			const http = await applyConfig(api, desired, { dryRun: true });

			expect(http.statusCode).toBe(400);
			expect(http.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
			expect(http.body.errors[0].message).toContain(refusal);

			const cli = await api.cli(['config', 'apply', fixtureRoot, '--dry-run', '--format', 'json']);

			expect(cli.status).toBe(2);
			expect(cli.stdout + cli.stderr).toContain(refusal);

			expect(await captureState(api, [table])).toEqual(before);
			expect(await api.database(table).select('id', 'title')).toEqual(rows);

			record['meta'] = null;
			file['meta'] = null;
			await writeTreeFile('schema', table, file);

			const restored = await applyConfig(api, desired, { dryRun: true });

			expect(restored.statusCode).toBe(200);
			expect(changesOf(restored.body.data, ['collections', 'fields', 'relations'])).toEqual([]);

			const restoredCli = await api.cli(['config', 'apply', fixtureRoot, '--dry-run', '--format', 'json']);

			expect(JSON.parse(restoredCli.stdout)).toEqual(restored.body.data);
		} finally {
			await api.database.schema.dropTableIfExists(table);
			await clearCache(api);
		}
	});

	for (const version of [1, 2]) {
		test(`plans a version ${version} tree as planVersion 2 without schema changes`, async ({ api }) => {
			const current = await snapshot(api, version);

			const response = await applyConfig(api, current, { dryRun: true });

			expect(response.statusCode).toBe(200);
			expect(response.body.data.planVersion).toBe(2);
			expect(response.body.data.changes).toEqual([]);
		});
	}
});
