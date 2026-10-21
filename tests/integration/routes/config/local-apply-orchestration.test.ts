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

	test('stops at a refused schema step after folder preparation commits, leaving configuration unapplied', async ({
		api,
	}) => {
		const id = randomUUID().replace(/-/g, '').slice(0, 8);
		const collection = `orch_stop_${id}`;
		const referenced = `orch_stop_ref_${id}`;
		const pending = `orch_stop_pending_${id}`;
		const dir = await fs.mkdtemp(path.join(api.directory, 'config-apply-stop-'));

		try {
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

			const snapshot = await api.cli(['config', 'snapshot', dir, '--yes']);
			expect(snapshot.status, snapshot.stderr).toBe(0);

			// Delete the folder-referencing field before its folder so no reference dangles. Keep title as a physical
			// field whose schema the tree then omits, and drop both folders so one is prepared and one is left to config.
			await admin(api, request(api.url).delete(`/fields/${collection}/cover`)).expect(204);
			await admin(api, request(api.url).delete(`/folders/${referencedId}`)).expect(204);
			await api.database('directus_folders').where({ key: pending }).delete();

			const document = await readSchemaFile(dir, collection);
			const fields = document['fields'] as Array<Record<string, unknown>>;
			delete fields.find((entry) => entry['field'] === 'title')!['schema'];
			await writeSchemaFile(dir, collection, document);

			const apply = await api.cli(['config', 'apply', dir, '--yes'], { env: { LOG_LEVEL: 'info', LOG_STYLE: 'raw' } });
			expect(apply.status).toBe(3);

			expect(await api.database('directus_folders').where({ key: referenced }).first()).toBeDefined();
			expect(await api.database('directus_folders').where({ key: pending }).first()).toBeUndefined();

			const output = `${apply.stdout}\n${apply.stderr}`;
			expect(output).toContain("can't remove its column and remain as a field");

			expect(output).toContain('Folder preparation: applied');
			expect(output).toContain('Schema: failed');
			expect(output).toContain('Configuration: not run');

			const record = findRunRecord(output);
			expect(record).toBeDefined();
			expect(record!['steps']).toEqual({ folders: 'committed', schema: 'failed', configuration: 'not_run' });
			expect(record!['failure']).toMatchObject({ step: 'schema' });
		} finally {
			await admin(api, request(api.url).delete(`/collections/${collection}`));
			await api.database('directus_folders').whereIn('key', [referenced, pending]).delete();
		}
	});
});
