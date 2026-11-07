import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import path from 'path';
import type { Test } from 'supertest';
import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { apiTest as test } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { CreateCollection, CreateField } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { isMysqlFamily } from '../../harness/database-vendors.mjs';

initializeFixtures();

type Document = Record<string, any>;

function admin(api: Api, req: Test): Test {
	return req.set('Authorization', `Bearer ${api.adminToken}`);
}

async function readSchemaFile(dir: string, stem: string): Promise<Document> {
	return loadYaml(await fs.readFile(path.join(dir, 'schema', `${stem}.yaml`), 'utf8')) as Document;
}

async function writeSchemaFile(dir: string, stem: string, document: Document): Promise<void> {
	await fs.writeFile(path.join(dir, 'schema', `${stem}.yaml`), dumpYaml(document));
}

function findRunRecord(output: string): Document | undefined {
	for (const line of output.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;

		try {
			const parsed = JSON.parse(trimmed);
			if (parsed?.event === 'config.run.finished') return parsed;
		} catch {
			// not a JSON record line
		}
	}

	return undefined;
}

async function createFolder(api: Api, key: string): Promise<string> {
	const response = await admin(api, request(api.url).post('/folders')).send({ name: key, key });
	expect(response.statusCode).toBe(200);
	return response.body.data.id;
}

function fieldOptions(field: { options: unknown }): Record<string, unknown> {
	return typeof field.options === 'string' ? JSON.parse(field.options) : (field.options as Record<string, unknown>);
}

describe('local config apply orchestration', () => {
	test('prepares a referenced folder, applies the schema field, and applies a folder change in one run', async ({
		api,
	}) => {
		const id = randomUUID().replace(/-/g, '').slice(0, 8);
		const collection = `orch_${id}`;
		const referenced = `orch_referenced_${id}`;
		const unreferenced = `orch_unreferenced_${id}`;
		const dir = await fs.mkdtemp(path.join(api.directory, 'config-apply-orchestration-'));

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

			const snapshot = await api.cli(['config', 'snapshot', dir, '--yes']);
			expect(snapshot.status, snapshot.stderr).toBe(0);

			// The field references the folder, so folder preparation must precede the schema step. The unreferenced
			// folder is left to the configuration step, which reconciles the full folders set.
			await admin(api, request(api.url).delete(`/fields/${collection}/cover`)).expect(204);
			await admin(api, request(api.url).delete(`/folders/${referencedId}`)).expect(204);
			await api.database('directus_folders').where({ key: unreferenced }).delete();

			const dryRun = await api.cli(['config', 'apply', dir, '--dry-run']);
			expect(dryRun.status).toBe(1);

			const dryOutput = `${dryRun.stdout}\n${dryRun.stderr}`;
			expect(dryOutput).toContain('Folder preparation');
			expect(dryOutput).toContain(referenced);

			const apply = await api.cli(['config', 'apply', dir, '--yes']);
			expect(apply.status, apply.stderr).toBe(0);
			expect(`${apply.stdout}\n${apply.stderr}`).toContain('Folder preparation: applied');

			const folder = await api.database('directus_folders').where({ key: referenced }).first();
			expect(folder).toBeDefined();

			const field = await api.database('directus_fields').where({ collection, field: 'cover' }).first();
			expect(field).toBeDefined();
			expect(fieldOptions(field)['folder']).toBe(folder.id);

			expect(await api.database('directus_folders').where({ key: unreferenced }).first()).toBeDefined();
		} finally {
			await admin(api, request(api.url).delete(`/collections/${collection}`));
			await api.database('directus_folders').whereIn('key', [referenced, unreferenced]).delete();
		}
	});

	test('refuses a pending schema change whose recorded vendor does not match, unless the schema override is passed', async ({
		api,
	}) => {
		const id = randomUUID().replace(/-/g, '').slice(0, 8);
		const collection = `orch_provenance_${id}`;
		const dir = await fs.mkdtemp(path.join(api.directory, 'config-apply-provenance-'));

		try {
			await CreateCollection(api, { collection });

			const snapshot = await api.cli(['config', 'snapshot', dir, '--yes']);
			expect(snapshot.status, snapshot.stderr).toBe(0);

			// Drop the collection so the tree carries a pending create, then record a vendor the instance does not use.
			await admin(api, request(api.url).delete(`/collections/${collection}`)).expect(204);

			const manifestPath = path.join(dir, 'cairncms-config.yaml');
			const manifest = await fs.readFile(manifestPath, 'utf8');
			await fs.writeFile(manifestPath, manifest.replace(/vendor:\s*\S+/, 'vendor: unrecognized_vendor'));

			const refused = await api.cli(['config', 'apply', dir, '--yes']);
			expect(refused.status).toBe(2);
			expect(await api.database.schema.hasTable(collection)).toBe(false);

			const forced = await api.cli(['config', 'apply', dir, '--yes', '--force-schema']);
			expect(forced.status, forced.stderr).toBe(0);
			expect(await api.database.schema.hasTable(collection)).toBe(true);
		} finally {
			await admin(api, request(api.url).delete(`/collections/${collection}`));
		}
	});

	type StopNames = { collection: string; referenced: string; pending: string };

	function stopNames(): StopNames {
		const id = randomUUID().replace(/-/g, '').slice(0, 8);
		return { collection: `orch_stop_${id}`, referenced: `orch_stop_ref_${id}`, pending: `orch_stop_pending_${id}` };
	}

	/**
	 * Captures a collection whose cover field references one folder, then removes that field and both folders from the
	 * target, so an apply of the captured tree prepares one folder and leaves the other to the configuration step.
	 */
	async function stopScenario(api: Api, dir: string, { collection, referenced, pending }: StopNames): Promise<void> {
		await CreateCollection(api, { collection });
		const referencedId = await createFolder(api, referenced);
		await createFolder(api, pending);

		await CreateField(api, {
			collection,
			field: 'cover',
			type: 'uuid',
			meta: { interface: 'file', options: { folder: referencedId } },
		});

		await CreateField(api, { collection, field: 'title', type: 'string' });
		await api.database(collection).insert({ title: 'kept' });

		const snapshot = await api.cli(['config', 'snapshot', dir, '--yes']);
		expect(snapshot.status, snapshot.stderr).toBe(0);

		await admin(api, request(api.url).delete(`/fields/${collection}/cover`)).expect(204);
		await admin(api, request(api.url).delete(`/folders/${referencedId}`)).expect(204);
		await api.database('directus_folders').where({ key: pending }).delete();
	}

	async function removeStopScenario(api: Api, { collection, referenced, pending }: StopNames): Promise<void> {
		await admin(api, request(api.url).delete(`/collections/${collection}`));
		await api.database('directus_folders').whereIn('key', [referenced, pending]).delete();
	}

	test('refuses a schema change the target cannot take before preparing folders, and writes nothing', async ({
		api,
	}) => {
		const dir = await fs.mkdtemp(path.join(api.directory, 'config-apply-refuse-'));
		const names = stopNames();
		const { collection } = names;

		try {
			await stopScenario(api, dir, names);

			const document = await readSchemaFile(dir, collection);
			const fields = document['fields'] as Array<Record<string, unknown>>;
			delete fields.find((entry) => entry['field'] === 'title')!['schema'];
			await writeSchemaFile(dir, collection, document);

			for (const flags of [['--dry-run'], ['--dry-run', '--format', 'json']]) {
				const dryRun = await api.cli(['config', 'apply', dir, ...flags]);
				expect(dryRun.status, dryRun.stderr).toBe(2);
				expect(`${dryRun.stdout}\n${dryRun.stderr}`).toContain("can't remove its column and remain as a field");
			}

			const apply = await api.cli(['config', 'apply', dir, '--yes'], { env: { LOG_LEVEL: 'info', LOG_STYLE: 'raw' } });
			expect(apply.status).toBe(2);

			expect(
				await api.database('directus_folders').whereIn('key', [names.referenced, names.pending]).first()
			).toBeUndefined();

			expect(await api.database.schema.hasColumn(collection, 'cover')).toBe(false);
			expect(await api.database(collection).select('title')).toEqual([{ title: 'kept' }]);

			const output = `${apply.stdout}\n${apply.stderr}`;
			expect(output).toContain("can't remove its column and remain as a field");
			expect(output).not.toContain('Folder preparation:');

			const record = findRunRecord(output);
			expect(record).toMatchObject({ result: 'invalid', errorCode: 'CONFIG_INVALID' });
			expect(record).not.toHaveProperty('failure');
		} finally {
			await removeStopScenario(api, names);
		}
	});

	test('stops at a schema step the database refuses after folder preparation commits, leaving configuration unapplied', async ({
		api,
		vendor,
	}) => {
		const dir = await fs.mkdtemp(path.join(api.directory, 'config-apply-stop-'));
		const names = stopNames();
		const { collection } = names;

		try {
			await stopScenario(api, dir, names);

			const partial = isMysqlFamily(vendor);
			const bad = partial ? 'f'.repeat(65) : 'required_no_default';

			const document = await readSchemaFile(dir, collection);

			(document['fields'] as Document[]).push({
				collection,
				field: bad,
				type: 'string',
				meta: null,
				schema: partial
					? { name: bad, table: collection, data_type: 'varchar' }
					: { name: bad, table: collection, data_type: 'varchar', is_nullable: false, default_value: null },
			});

			await writeSchemaFile(dir, collection, document);

			const apply = await api.cli(['config', 'apply', dir, '--yes'], { env: { LOG_LEVEL: 'info', LOG_STYLE: 'raw' } });
			expect(apply.status).toBe(3);

			expect(await api.database('directus_folders').where({ key: names.referenced }).first()).toBeDefined();
			expect(await api.database('directus_folders').where({ key: names.pending }).first()).toBeUndefined();

			const output = `${apply.stdout}\n${apply.stderr}`;
			expect(output).toContain('Folder preparation: applied');
			expect(output).toContain('Schema: failed');
			expect(output).toContain('Configuration: not run');

			const record = findRunRecord(output);
			expect(record).toBeDefined();
			expect(record!['errorCode']).toBe('SCHEMA_APPLY_FAILED');
			expect(record!['steps']).toEqual({ folders: 'committed', schema: 'failed', configuration: 'not_run' });
			expect(record!['failure']).toMatchObject({ step: 'schema' });
		} finally {
			await removeStopScenario(api, names);
		}
	});

	async function readTree(dir: string): Promise<Record<string, string>> {
		const files: Record<string, string> = {};

		for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const file = path.join(entry.parentPath, entry.name);
			files[path.relative(dir, file)] = await fs.readFile(file, 'utf8');
		}

		return files;
	}

	test('reports a stored field whose upload folder was deleted as a read failure, writing nothing', async ({ api }) => {
		const id = randomUUID().replace(/-/g, '').slice(0, 8);
		const collection = `orch_read_${id}`;
		const folderKey = `orch_read_folder_${id}`;
		const dir = await fs.mkdtemp(path.join(api.directory, 'config-read-failed-'));

		try {
			await CreateCollection(api, { collection });
			const folderId = await createFolder(api, folderKey);

			await CreateField(api, {
				collection,
				field: 'cover',
				type: 'uuid',
				meta: { interface: 'file', options: { folder: folderId } },
			});

			const snapshot = await api.cli(['config', 'snapshot', dir, '--yes']);
			expect(snapshot.status, snapshot.stderr).toBe(0);

			const captured = await readTree(dir);
			await admin(api, request(api.url).delete(`/folders/${folderId}`)).expect(204);

			const recapture = await api.cli(['config', 'snapshot', dir, '--yes']);
			expect(recapture.status).toBe(3);
			expect(`${recapture.stdout}\n${recapture.stderr}`).toContain(`Field "${collection}.cover" references folder`);
			expect(await readTree(dir)).toEqual(captured);

			const apply = await api.cli(['config', 'apply', dir, '--yes'], { env: { LOG_LEVEL: 'info', LOG_STYLE: 'raw' } });
			expect(apply.status).toBe(3);

			const output = `${apply.stdout}\n${apply.stderr}`;
			expect(output).toContain('Select an existing folder for the field on the target');
			expect(await api.database('directus_folders').where({ key: folderKey }).first()).toBeUndefined();

			const record = findRunRecord(output);
			expect(record).toMatchObject({ result: 'failed', errorCode: 'CONFIG_READ_FAILED' });
			expect(record).not.toHaveProperty('steps');
		} finally {
			await admin(api, request(api.url).delete(`/collections/${collection}`));
			await api.database('directus_folders').where({ key: folderKey }).delete();
		}
	});
});
