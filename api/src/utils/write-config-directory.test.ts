import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { load as loadYaml } from 'js-yaml';
import { writeConfigDirectory } from './write-config-directory.js';
import type { DirectusConfig } from '../types/config.js';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-test-'));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides?: Partial<DirectusConfig>): DirectusConfig {
	return {
		manifest: { version: 1, resources: ['roles', 'permissions'] },
		roles: [],
		permissions: [],
		...overrides,
	};
}

async function readYaml(filePath: string): Promise<any> {
	const content = await fs.readFile(filePath, 'utf-8');
	return loadYaml(content);
}

describe('writeConfigDirectory', () => {
	it('writes manifest, role files, and permission files', async () => {
		const config = makeConfig({
			roles: [{ key: 'editor', name: 'Editor', admin_access: false, app_access: true }],
			permissions: [
				{
					role: 'editor',
					permissions: [
						{
							collection: 'articles',
							action: 'read',
							permissions: null,
							validation: null,
							presets: null,
							fields: null,
						},
					],
				},
			],
		});

		await writeConfigDirectory(config, tmpDir);

		const manifest = await readYaml(path.join(tmpDir, 'cairncms-config.yaml'));
		expect(manifest.version).toBe(1);

		const role = await readYaml(path.join(tmpDir, 'roles', 'editor.yaml'));
		expect(role.name).toBe('Editor');

		const perms = await readYaml(path.join(tmpDir, 'permissions', 'editor.yaml'));
		expect(perms.role).toBe('editor');
		expect(perms.permissions).toHaveLength(1);
	});

	it('sorts roles by key', async () => {
		const config = makeConfig({
			roles: [
				{ key: 'zebra', name: 'Zebra', admin_access: false, app_access: false },
				{ key: 'alpha', name: 'Alpha', admin_access: false, app_access: false },
			],
		});

		await writeConfigDirectory(config, tmpDir);

		const files = await fs.readdir(path.join(tmpDir, 'roles'));
		expect(files.sort()).toEqual(['alpha.yaml', 'zebra.yaml']);
	});

	it('sorts permission sets by role', async () => {
		const config = makeConfig({
			permissions: [
				{ role: 'zebra', permissions: [] },
				{ role: 'alpha', permissions: [] },
			],
		});

		await writeConfigDirectory(config, tmpDir);

		const files = await fs.readdir(path.join(tmpDir, 'permissions'));
		expect(files.sort()).toEqual(['alpha.yaml', 'zebra.yaml']);
	});

	it('sorts permissions by (collection, action)', async () => {
		const config = makeConfig({
			permissions: [
				{
					role: 'editor',
					permissions: [
						{ collection: 'posts', action: 'read', permissions: null, validation: null, presets: null, fields: null },
						{
							collection: 'articles',
							action: 'update',
							permissions: null,
							validation: null,
							presets: null,
							fields: null,
						},
						{
							collection: 'articles',
							action: 'read',
							permissions: null,
							validation: null,
							presets: null,
							fields: null,
						},
					],
				},
			],
		});

		await writeConfigDirectory(config, tmpDir);

		const perms = await readYaml(path.join(tmpDir, 'permissions', 'editor.yaml'));

		expect(perms.permissions.map((p: any) => `${p.collection}:${p.action}`)).toEqual([
			'articles:read',
			'articles:update',
			'posts:read',
		]);
	});

	it('sorts fields alphabetically', async () => {
		const config = makeConfig({
			permissions: [
				{
					role: 'editor',
					permissions: [
						{
							collection: 'articles',
							action: 'read',
							permissions: null,
							validation: null,
							presets: null,
							fields: ['title', 'author', 'body'],
						},
					],
				},
			],
		});

		await writeConfigDirectory(config, tmpDir);

		const perms = await readYaml(path.join(tmpDir, 'permissions', 'editor.yaml'));
		expect(perms.permissions[0].fields).toEqual(['author', 'body', 'title']);
	});

	it('sorts ip_access alphabetically', async () => {
		const config = makeConfig({
			roles: [
				{
					key: 'restricted',
					name: 'Restricted',
					admin_access: false,
					app_access: true,
					ip_access: ['10.0.0.1', '192.168.1.1', '10.0.0.2'],
				},
			],
		});

		await writeConfigDirectory(config, tmpDir);

		const role = await readYaml(path.join(tmpDir, 'roles', 'restricted.yaml'));
		expect(role.ip_access).toEqual(['10.0.0.1', '10.0.0.2', '192.168.1.1']);
	});

	it('removes stale .yaml files', async () => {
		const rolesDir = path.join(tmpDir, 'roles');
		const permDir = path.join(tmpDir, 'permissions');
		await fs.mkdir(rolesDir, { recursive: true });
		await fs.mkdir(permDir, { recursive: true });

		await fs.writeFile(path.join(rolesDir, 'old_role.yaml'), 'stale');
		await fs.writeFile(path.join(permDir, 'old_role.yaml'), 'stale');

		const config = makeConfig({
			roles: [{ key: 'editor', name: 'Editor', admin_access: false, app_access: true }],
		});

		await writeConfigDirectory(config, tmpDir);

		const roleFiles = await fs.readdir(rolesDir);
		expect(roleFiles).toEqual(['editor.yaml']);

		const permFiles = await fs.readdir(permDir);
		expect(permFiles).toEqual([]);
	});

	it('preserves non-.yaml files', async () => {
		const rolesDir = path.join(tmpDir, 'roles');
		await fs.mkdir(rolesDir, { recursive: true });

		await fs.writeFile(path.join(rolesDir, 'README.md'), 'keep me');
		await fs.writeFile(path.join(rolesDir, '.gitkeep'), '');

		const config = makeConfig();

		await writeConfigDirectory(config, tmpDir);

		const files = await fs.readdir(rolesDir);
		expect(files.sort()).toEqual(['.gitkeep', 'README.md']);
	});

	it('writes permissions/public.yaml for public permissions', async () => {
		const config = makeConfig({
			permissions: [
				{
					role: 'public',
					permissions: [
						{
							collection: 'articles',
							action: 'read',
							permissions: null,
							validation: null,
							presets: null,
							fields: ['title', 'body'],
						},
					],
				},
			],
		});

		await writeConfigDirectory(config, tmpDir);

		const perms = await readYaml(path.join(tmpDir, 'permissions', 'public.yaml'));
		expect(perms.role).toBe('public');
		expect(perms.permissions).toHaveLength(1);
		expect(perms.permissions[0].collection).toBe('articles');
	});
});
