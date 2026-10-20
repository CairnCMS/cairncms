import { describe, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Api } from '../../fixtures/environment';
import { apiTest as test } from '../../fixtures/environment';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const entry = fileURLToPath(new URL('../../fixtures/folder-preparation-entry.mjs', import.meta.url));

type Folder = { key: string; name: string; parent: string | null };

type WireDocument = {
	manifest: { version: number; resources: string[] };
	roles: unknown[];
	permissions: unknown[];
	folders: Folder[];
	settings: unknown[];
	'extension-settings': unknown[];
	translations: unknown[];
	schema: Array<Record<string, unknown>>;
};

function wireDocument(folders: Folder[], referencedFolder: string): WireDocument {
	const cover = {
		collection: 'articles',
		field: 'cover',
		type: 'uuid',
		schema: null,
		meta: { interface: 'file', options: { folder: referencedFolder } },
	};

	return {
		manifest: { version: 3, resources: ['folders', 'schema'] },
		roles: [],
		permissions: [],
		folders,
		settings: [],
		'extension-settings': [],
		translations: [],
		schema: [{ collection: 'articles', meta: {}, fields: [cover], relations: [] }],
	};
}

// Delete in the given order (children before parents) so the parent foreign key never blocks teardown.
async function removeFolders(api: Api, keys: string[]): Promise<void> {
	for (const key of keys) await api.database('directus_folders').where({ key }).del();
}

async function prepare(api: Api, document: WireDocument): Promise<string[]> {
	const documentPath = join(api.directory, 'desired-folder-preparation.json');
	const outputPath = join(api.directory, 'created-folder-preparation.json');
	await writeFile(documentPath, JSON.stringify(document));

	const tool = api.startNode(entry, [documentPath, outputPath]);
	tool.child.stdin!.end();
	const result = await tool.result;

	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(await readFile(outputPath, 'utf8')) as string[];
}

async function folderTree(api: Api): Promise<Record<string, string | null>> {
	const rows = await api.database('directus_folders').select('id', 'key', 'parent');
	const keyById = new Map(rows.map((row) => [row.id, row.key]));
	return Object.fromEntries(rows.map((row) => [row.key, row.parent === null ? null : keyById.get(row.parent) ?? null]));
}

describe('creation-only folder preparation through the engine', () => {
	test('creates a referenced parent chain parent first', async ({ api }) => {
		try {
			const created = await prepare(
				api,
				wireDocument(
					[
						{ key: 'prep_leaf', name: 'prep_leaf', parent: 'prep_branch' },
						{ key: 'prep_branch', name: 'prep_branch', parent: 'prep_root' },
						{ key: 'prep_root', name: 'prep_root', parent: null },
					],
					'prep_leaf'
				)
			);

			expect(created).toEqual(['prep_root', 'prep_branch', 'prep_leaf']);

			const tree = await folderTree(api);
			expect(tree['prep_root']).toBeNull();
			expect(tree['prep_branch']).toBe('prep_root');
			expect(tree['prep_leaf']).toBe('prep_branch');
		} finally {
			await removeFolders(api, ['prep_leaf', 'prep_branch', 'prep_root']);
		}
	});

	test('creates nothing when the referenced folder is already present', async ({ api }) => {
		const document = wireDocument([{ key: 'prep_assets', name: 'prep_assets', parent: null }], 'prep_assets');

		try {
			expect(await prepare(api, document)).toEqual(['prep_assets']);
			const present = await folderTree(api);

			expect(await prepare(api, document)).toEqual([]);
			expect(await folderTree(api)).toEqual(present);
		} finally {
			await removeFolders(api, ['prep_assets']);
		}
	});
});
