import { randomUUID, createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import type { Test } from 'supertest';
import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest } from '../../fixtures/identities';
import request from '../../fixtures/request';
import { CreateCollection, CreateField } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const SUBJECT = 'cairncms-extension-settings-fixture';
const SETTINGS_FILE = `${SUBJECT}-${createHash('sha256').update(SUBJECT).digest('hex').slice(0, 8)}.yaml`;
const CLI_TIMEOUT = 25000;
const run = randomUUID().replace(/-/g, '').slice(0, 8);

const test = createIdentityTest({ extensions: [SUBJECT] });

type Folder = { id: string; key: string; name: string; parent: string | null };

function admin(api: Api, req: Test): Test {
	return req.set('Authorization', `Bearer ${api.adminToken}`);
}

async function createFolder(api: Api, key: string): Promise<string> {
	const res = await admin(api, request(api.url).post('/folders')).send({ name: key, key });
	expect(res.statusCode).toBe(200);
	return res.body.data.id;
}

async function remove(api: Api, route: string): Promise<void> {
	const res = await admin(api, request(api.url).delete(route));
	expect([204, 403, 404]).toContain(res.statusCode);
}

async function uploadField(api: Api, collection: string, field: string, meta: Record<string, unknown>) {
	await CreateField(api, { collection, field, type: 'uuid', meta });
}

async function storedMeta(api: Api, collection: string, field: string): Promise<any> {
	const res = await admin(api, request(api.url).get(`/fields/${collection}/${field}`));
	expect(res.statusCode).toBe(200);
	return res.body.data.meta;
}

async function snapshot(api: Api, version?: number) {
	return admin(api, request(api.url).get(`/schema/snapshot${version ? `?version=${version}` : ''}`));
}

function fieldIn(snapshotData: any, collection: string, field: string): any {
	return snapshotData.fields.find((entry: any) => entry.collection === collection && entry.field === field);
}

async function applySnapshot(api: Api, snapshotData: unknown): Promise<void> {
	const diff = await admin(api, request(api.url).post('/schema/diff')).send(snapshotData);
	if (diff.statusCode === 204) return;
	expect(diff.statusCode).toBe(200);

	const apply = await admin(api, request(api.url).post('/schema/apply')).send(diff.body.data);
	expect(apply.statusCode).toBe(204);
}

describe('portable folder references in schema snapshots', () => {
	test('round-trips an upload folder by key and uploads into the target folder', async ({ api }) => {
		const collection = `fr_${run}_trip`;
		const key = `fr_${run}_trip_images`;
		let folder = await createFolder(api, key);
		let file: string | undefined;

		try {
			await CreateCollection(api, { collection });
			await uploadField(api, collection, 'image', { interface: 'file', options: { folder } });

			const exported = await snapshot(api, 2);
			expect(exported.statusCode).toBe(200);
			expect(exported.body.data.version).toBe(2);
			expect(fieldIn(exported.body.data, collection, 'image').meta.options.folder).toBe(key);

			await remove(api, `/fields/${collection}/image`);
			await remove(api, `/folders/${folder}`);
			folder = await createFolder(api, key);

			await applySnapshot(api, exported.body.data);

			expect((await storedMeta(api, collection, 'image')).options.folder).toBe(folder);

			const upload = await admin(api, request(api.url).post('/files'))
				.field('folder', folder)
				.attach('file', Buffer.from('portable folder'), 'portable.txt');

			expect(upload.statusCode).toBe(200);
			file = upload.body.data.id;
			expect(upload.body.data.folder).toBe(folder);
		} finally {
			if (file) await remove(api, `/files/${file}`);
			await remove(api, `/collections/${collection}`);
			await remove(api, `/folders/${folder}`);
		}
	});

	test('round-trips repeater sub-field and condition folders by key', async ({ api }) => {
		const collection = `fr_${run}_nested`;
		const key = `fr_${run}_nested_images`;
		let folder = await createFolder(api, key);

		try {
			await CreateCollection(api, { collection });

			await CreateField(api, {
				collection,
				field: 'items',
				type: 'json',
				meta: {
					interface: 'list',
					options: {
						fields: [
							{
								field: 'body',
								name: 'body',
								type: 'text',
								meta: { field: 'body', type: 'text', interface: 'input-rich-text-md', options: { folder } },
							},
						],
					},
				},
			});

			await uploadField(api, collection, 'attachment', {
				interface: 'file',
				options: null,
				conditions: [{ name: 'locked', rule: {}, options: { folder } }],
			});

			const exported = await snapshot(api, 2);
			const items = fieldIn(exported.body.data, collection, 'items');
			const attachment = fieldIn(exported.body.data, collection, 'attachment');
			expect(items.meta.options.fields[0].meta.options.folder).toBe(key);
			expect(attachment.meta.conditions[0].options.folder).toBe(key);

			await remove(api, `/fields/${collection}/items`);
			await remove(api, `/fields/${collection}/attachment`);
			await remove(api, `/folders/${folder}`);
			folder = await createFolder(api, key);

			await applySnapshot(api, exported.body.data);

			expect((await storedMeta(api, collection, 'items')).options.fields[0].meta.options.folder).toBe(folder);
			expect((await storedMeta(api, collection, 'attachment')).conditions[0].options.folder).toBe(folder);
		} finally {
			await remove(api, `/collections/${collection}`);
			await remove(api, `/folders/${folder}`);
		}
	});

	test('exports version 1 with folder IDs by default, and a version 1 snapshot diffs empty', async ({ api }) => {
		const collection = `fr_${run}_v1`;
		const folder = await createFolder(api, `fr_${run}_v1_images`);

		try {
			await CreateCollection(api, { collection });
			await uploadField(api, collection, 'image', { interface: 'file', options: { folder } });

			const exported = await snapshot(api);
			expect(exported.statusCode).toBe(200);
			expect(exported.body.data.version).toBe(1);
			expect(fieldIn(exported.body.data, collection, 'image').meta.options.folder).toBe(folder);

			const diff = await admin(api, request(api.url).post('/schema/diff')).send(exported.body.data);
			expect(diff.statusCode).toBe(204);
		} finally {
			await remove(api, `/collections/${collection}`);
			await remove(api, `/folders/${folder}`);
		}
	});

	test('refuses a version 2 snapshot whose folder key has no folder, or that holds a folder ID', async ({ api }) => {
		const collection = `fr_${run}_refused`;
		const folder = await createFolder(api, `fr_${run}_refused_images`);

		try {
			await CreateCollection(api, { collection });
			await uploadField(api, collection, 'image', { interface: 'file', options: { folder } });

			const exported = (await snapshot(api, 2)).body.data;

			fieldIn(exported, collection, 'image').meta.options.folder = `fr_${run}_missing`;
			const missing = await admin(api, request(api.url).post('/schema/diff')).send(exported);

			expect(missing.statusCode).toBe(400);

			expect(missing.body.errors[0].message).toBe(
				`Folder reference "fr_${run}_missing" could not be resolved. Referenced by: ${collection}.image.meta.options.folder`
			);

			fieldIn(exported, collection, 'image').meta.options.folder = folder;
			const raw = await admin(api, request(api.url).post('/schema/diff')).send(exported);

			expect(raw.statusCode).toBe(400);
			expect(raw.body.errors[0].message).toContain('is not a folder key');
		} finally {
			await remove(api, `/collections/${collection}`);
			await remove(api, `/folders/${folder}`);
		}
	});

	test('refuses a version 2 export of a field whose folder was deleted, and repairs it on apply', async ({ api }) => {
		const collection = `fr_${run}_dangling`;
		const key = `fr_${run}_dangling_images`;
		let folder = await createFolder(api, key);

		try {
			await CreateCollection(api, { collection });
			await uploadField(api, collection, 'image', { interface: 'file', options: { folder } });

			const portable = (await snapshot(api, 2)).body.data;
			await remove(api, `/folders/${folder}`);

			const refused = await snapshot(api, 2);
			expect(refused.statusCode).toBe(422);
			expect(refused.body.errors[0].message).toContain(`Field "${collection}.image" references folder`);

			expect((await snapshot(api)).statusCode).toBe(200);

			folder = await createFolder(api, key);
			await applySnapshot(api, portable);

			expect((await storedMeta(api, collection, 'image')).options.folder).toBe(folder);
		} finally {
			await remove(api, `/collections/${collection}`);
			await remove(api, `/folders/${folder}`);
		}
	});

	test('leaves an option named folder on an unregistered interface as it is', async ({ api }) => {
		const collection = `fr_${run}_unregistered`;
		const value = randomUUID();

		try {
			await CreateCollection(api, { collection });
			await uploadField(api, collection, 'reference', { interface: 'input', options: { folder: value } });

			const exported = await snapshot(api, 2);
			expect(exported.statusCode).toBe(200);
			expect(fieldIn(exported.body.data, collection, 'reference').meta.options.folder).toBe(value);
		} finally {
			await remove(api, `/collections/${collection}`);
		}
	});

	test('refuses an apply whose folder disappeared after the diff, before creating anything', async ({ api }) => {
		const existing = `fr_${run}_existing`;
		const created = `fr_${run}_created`;
		const folder = await createFolder(api, `fr_${run}_late_images`);

		try {
			await CreateCollection(api, { collection: existing });
			await CreateCollection(api, { collection: created });
			await uploadField(api, existing, 'image', { interface: 'file', options: { folder } });

			const desired = (await snapshot(api, 2)).body.data;

			await remove(api, `/collections/${created}`);
			await remove(api, `/fields/${existing}/image`);

			const diff = await admin(api, request(api.url).post('/schema/diff')).send(desired);
			expect(diff.statusCode).toBe(200);

			await remove(api, `/folders/${folder}`);

			const apply = await admin(api, request(api.url).post('/schema/apply')).send(diff.body.data);
			expect(apply.statusCode).toBe(400);
			expect(apply.body.errors[0].message).toContain('could not be resolved');

			expect(await api.database.schema.hasTable(created)).toBe(false);
			expect(await api.database('directus_collections').where({ collection: created })).toHaveLength(0);
		} finally {
			await remove(api, `/collections/${created}`);
			await remove(api, `/collections/${existing}`);
			await remove(api, `/folders/${folder}`);
		}
	});

	test('refuses an apply as stale when a folder the schema uses was deleted after the diff', async ({ api }) => {
		const collection = `fr_${run}_stale`;
		const folder = await createFolder(api, `fr_${run}_stale_images`);

		try {
			await CreateCollection(api, { collection });
			await uploadField(api, collection, 'image', { interface: 'file', note: null, options: { folder } });

			const desired = (await snapshot(api, 2)).body.data;
			fieldIn(desired, collection, 'image').meta.note = 'Hero image';

			const diff = await admin(api, request(api.url).post('/schema/diff')).send(desired);
			expect(diff.statusCode).toBe(200);

			await remove(api, `/folders/${folder}`);

			const apply = await admin(api, request(api.url).post('/schema/apply')).send(diff.body.data);
			expect(apply.statusCode).toBe(400);
			expect(apply.body.errors[0].message).toContain('Provided hash does not match');

			expect((await storedMeta(api, collection, 'image')).note).toBeNull();
		} finally {
			await remove(api, `/collections/${collection}`);
			await remove(api, `/folders/${folder}`);
		}
	});
});

describe('version 2 schema snapshots with config, through the CLI', () => {
	async function currentFolders(api: Api): Promise<Folder[]> {
		const res = await admin(api, request(api.url).get('/folders?fields=id,key,name,parent&limit=-1'));
		expect(res.statusCode).toBe(200);
		return res.body.data;
	}

	async function writeConfig(
		dir: string,
		folders: { key: string; name: string; parent: string | null }[],
		collectionSettings?: Record<string, Record<string, unknown>>
	): Promise<void> {
		await fs.mkdir(path.join(dir, 'folders'), { recursive: true });

		await fs.writeFile(
			path.join(dir, 'cairncms-config.yaml'),
			dumpYaml({ version: 2, resources: ['folders', 'extension-settings'] })
		);

		for (const folder of folders) {
			await fs.writeFile(path.join(dir, 'folders', `${folder.key}.yaml`), dumpYaml(folder));
		}

		if (collectionSettings) {
			await fs.mkdir(path.join(dir, 'extension-settings'), { recursive: true });

			await fs.writeFile(
				path.join(dir, 'extension-settings', SETTINGS_FILE),
				dumpYaml({ subject: SUBJECT, global: {}, collections: collectionSettings })
			);
		}
	}

	function cli(api: Api, args: string[]) {
		return api.cli(args, { timeoutMs: CLI_TIMEOUT });
	}

	test('replaces a folder and adds a collection with a setting, across two deployments', async ({ api }) => {
		const posts = `fr_${run}_posts`;
		const articles = `fr_${run}_articles`;
		const keyA = `fr_${run}_folder_a`;
		const keyB = `fr_${run}_folder_b`;
		const dir = await fs.mkdtemp(path.join(api.directory, 'folder-references-'));
		const folderA = await createFolder(api, keyA);

		try {
			await CreateCollection(api, { collection: posts });
			await uploadField(api, posts, 'image', { interface: 'file', options: { folder: folderA } });

			const others = (await currentFolders(api)).filter((folder) => folder.key !== keyA);
			const keyById = new Map((await currentFolders(api)).map((folder) => [folder.id, folder.key]));

			const declared = others.map((folder) => ({
				key: folder.key,
				name: folder.name,
				parent: folder.parent === null ? null : keyById.get(folder.parent)!,
			}));

			const intermediate = path.join(dir, 'intermediate');
			const final = path.join(dir, 'final');

			await writeConfig(intermediate, [
				...declared,
				{ key: keyA, name: keyA, parent: null },
				{ key: keyB, name: keyB, parent: null },
			]);

			await writeConfig(final, [...declared, { key: keyB, name: keyB, parent: null }], {
				[articles]: { preview_url: 'https://preview.example' },
			});

			const early = await cli(api, ['config', 'apply', '--yes', '--destructive', final]);
			expect(early.error).toBeUndefined();
			expect(early.signal).toBeNull();
			expect(early.status).toBe(2);
			const earlyOutput = `${early.stdout ?? ''}${early.stderr ?? ''}`;
			expect(earlyOutput).toContain(articles);
			expect(earlyOutput).toContain('does not exist');
			const foldersAfterEarly = (await currentFolders(api)).map((folder) => folder.key);
			expect(foldersAfterEarly).not.toContain(keyB);
			expect(foldersAfterEarly).toContain(keyA);

			const deployment1 = await cli(api, ['config', 'apply', '--yes', intermediate]);
			expect(deployment1.status).toBe(0);
			const folderB = (await currentFolders(api)).find((folder) => folder.key === keyB)!.id;

			await CreateCollection(api, { collection: articles });
			await uploadField(api, articles, 'upload', { interface: 'file', options: { folder: folderB } });

			await admin(api, request(api.url).patch(`/fields/${posts}/image`)).send({
				meta: { options: { folder: folderB } },
			});

			const schemaFile = path.join(dir, 'schema.yaml');
			await fs.writeFile(schemaFile, 'version: 2\n');

			const snapshotRun = await cli(api, ['schema', 'snapshot', '--yes', schemaFile]);
			expect(snapshotRun.status).toBe(0);

			const written = loadYaml(await fs.readFile(schemaFile, 'utf8')) as any;
			expect(written.version).toBe(2);
			expect(fieldIn(written, posts, 'image').meta.options.folder).toBe(keyB);

			await remove(api, `/collections/${articles}`);

			await admin(api, request(api.url).patch(`/fields/${posts}/image`)).send({
				meta: { options: { folder: folderA } },
			});

			const schemaApply = await cli(api, ['schema', 'apply', '--yes', schemaFile]);
			expect(schemaApply.status).toBe(0);
			expect((await admin(api, request(api.url).post('/utils/cache/clear'))).statusCode).toBe(200);

			const deployment2 = await cli(api, ['config', 'apply', '--yes', '--destructive', final]);
			expect(deployment2.status).toBe(0);

			expect((await currentFolders(api)).map((folder) => folder.key)).not.toContain(keyA);
			expect((await storedMeta(api, posts, 'image')).options.folder).toBe(folderB);
			expect((await storedMeta(api, articles, 'upload')).options.folder).toBe(folderB);

			const unsupported = path.join(dir, 'unsupported.yaml');
			await fs.writeFile(unsupported, dumpYaml({ ...written, version: 3 }));

			const refused = await cli(api, ['schema', 'apply', '--yes', unsupported]);
			expect(refused.error).toBeUndefined();
			expect(refused.signal).toBeNull();
			expect(refused.status).toBe(1);
			expect(`${refused.stdout ?? ''}${refused.stderr ?? ''}`).toContain('must be one of [1, 2]');
			expect((await storedMeta(api, posts, 'image')).options.folder).toBe(folderB);
		} finally {
			await api.database('cairncms_extension_settings').where({ extension: SUBJECT }).delete();
			await remove(api, `/collections/${articles}`);
			await remove(api, `/collections/${posts}`);

			for (const folder of await currentFolders(api)) {
				if (folder.key === keyA || folder.key === keyB) await remove(api, `/folders/${folder.id}`);
			}

			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
