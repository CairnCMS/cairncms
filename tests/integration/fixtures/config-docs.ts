import type { DeepPartial, Field } from '@cairncms/types';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, inject } from 'vitest';
import type { Api } from './environment';
import { setupRequest } from './request';
import { CreateCollection, CreateField, CreateRelation, CreateRole } from './schema';

export const DOCS_COLLECTION = 'articles';
export const DOCS_FOLDER = 'article_images';
export const DOCS_ROLE = 'documentation_editor';
export const DOCS_RESOURCES = ['roles', 'folders', 'schema'];

export async function assertDocsLabAbsent(api: Api): Promise<void> {
	expect(await api.database.schema.hasTable(DOCS_COLLECTION)).toBe(false);
	expect(await api.database('directus_collections').where({ collection: DOCS_COLLECTION }).first()).toBeUndefined();
	expect(await api.database('directus_fields').where({ collection: DOCS_COLLECTION })).toEqual([]);
	expect(await api.database('directus_folders').where({ key: DOCS_FOLDER }).first()).toBeUndefined();
	expect(await api.database('directus_roles').where({ key: DOCS_ROLE }).first()).toBeUndefined();
}

export async function createDocsLab(api: Api): Promise<void> {
	const folder = await setupRequest(api.url)
		.post('/folders')
		.auth(api.adminToken, { type: 'bearer' })
		.send({ name: 'Article images' })
		.expect(200);

	expect(folder.body.data.key).toBe(DOCS_FOLDER);
	await CreateCollection(api, { collection: DOCS_COLLECTION });
	await CreateField(api, { collection: DOCS_COLLECTION, field: 'title', type: 'string', meta: { interface: 'input' } });

	const cover: DeepPartial<Field> = {
		collection: DOCS_COLLECTION,
		field: 'cover',
		type: 'uuid',
		meta: { interface: 'file', special: ['file'], options: { folder: folder.body.data.id } },
	};

	await setupRequest(api.url)
		.post(`/fields/${DOCS_COLLECTION}`)
		.auth(api.adminToken, { type: 'bearer' })
		.send(cover)
		.expect(200);

	await CreateRelation(api, {
		collection: DOCS_COLLECTION,
		field: 'cover',
		related_collection: 'directus_files',
		schema: { on_delete: 'SET NULL' },
	});

	const role = await CreateRole(api, {
		name: 'Documentation Editor',
		appAccessEnabled: true,
		adminAccessEnabled: false,
	});

	expect(role.key).toBe(DOCS_ROLE);
}

export async function removeDocsLab(api: Api): Promise<void> {
	if (await api.database.schema.hasTable(DOCS_COLLECTION)) {
		await setupRequest(api.url)
			.delete(`/collections/${DOCS_COLLECTION}`)
			.auth(api.adminToken, { type: 'bearer' })
			.expect(204);
	}

	for (const [table, key, route] of [
		['directus_folders', DOCS_FOLDER, 'folders'],
		['directus_roles', DOCS_ROLE, 'roles'],
	]) {
		const row = await api.database(table!).where({ key }).first();
		if (row)
			await setupRequest(api.url).delete(`/${route}/${row.id}`).auth(api.adminToken, { type: 'bearer' }).expect(204);
	}
}

export async function assertDocsLabRestored(api: Api): Promise<void> {
	expect(await api.database.schema.hasColumn(DOCS_COLLECTION, 'title')).toBe(true);
	expect(await api.database.schema.hasColumn(DOCS_COLLECTION, 'cover')).toBe(true);
	expect(await api.database(DOCS_COLLECTION).select('*')).toEqual([]);
	const folder = await api.database('directus_folders').where({ key: DOCS_FOLDER }).first();
	expect(folder).toMatchObject({ name: 'Article images' });
	const field = await api.database('directus_fields').where({ collection: DOCS_COLLECTION, field: 'cover' }).first();
	const options = typeof field.options === 'string' ? JSON.parse(field.options) : field.options;
	expect(options.folder).toBe(folder.id);
	expect(field.interface).toBe('file');

	expect(
		await api.database('directus_relations').where({ many_collection: DOCS_COLLECTION, many_field: 'cover' }).first()
	).toMatchObject({ one_collection: 'directus_files' });

	const role = await api.database('directus_roles').where({ key: DOCS_ROLE }).first();
	expect(role.name).toBe('Documentation Editor');
	expect(Boolean(role.app_access)).toBe(true);
	expect(Boolean(role.admin_access)).toBe(false);
	expect(await api.database('directus_roles').where({ admin_access: true })).not.toHaveLength(0);
}

export async function docsManifest(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true });

	await fs.writeFile(
		path.join(directory, 'cairncms-config.yaml'),
		'version: 3\nresources:\n  - roles\n  - folders\n  - schema\n'
	);
}

export async function docsSnapshot(api: Api, resources = DOCS_RESOURCES) {
	const response = await setupRequest(api.url)
		.get('/config/snapshot')
		.query({ manifest_version: 3, resources: resources.join(',') })
		.auth(api.adminToken, { type: 'bearer' })
		.expect(200);

	return response.body.data;
}

export async function recordDocsEvidence(name: string, evidence: unknown): Promise<void> {
	const directory = path.join(inject('integration').directory, 'docs-evidence');
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(evidence, null, 2) + '\n');
}
