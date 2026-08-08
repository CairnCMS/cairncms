import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import { writeConfigDirectory } from './write-config-directory.js';
import logger from '../logger.js';
import type { CairnConfig } from '../types/config.js';

vi.mock('../logger.js', () => ({
	default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

let tmpDir: string;

beforeEach(async () => {
	vi.clearAllMocks();
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-test-'));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides?: Partial<CairnConfig>): CairnConfig {
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

	it('removes a stale record that declares the identity its filename promises', async () => {
		const rolesDir = path.join(tmpDir, 'roles');
		const permDir = path.join(tmpDir, 'permissions');
		await fs.mkdir(rolesDir, { recursive: true });
		await fs.mkdir(permDir, { recursive: true });

		// A valid record is engine-owned regardless of its author, because snapshots do not track provenance.
		await fs.writeFile(path.join(rolesDir, 'old_role.yaml'), dumpYaml({ key: 'old_role', name: 'Old' }));
		await fs.writeFile(path.join(permDir, 'old_role.yaml'), dumpYaml({ role: 'old_role', permissions: [] }));

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

	it('leaves an owned filename that does not read as a config record', async () => {
		const rolesDir = path.join(tmpDir, 'roles');
		await fs.mkdir(rolesDir, { recursive: true });
		await fs.writeFile(path.join(rolesDir, 'notes.yaml'), 'this: [is, not, valid\n  yaml: {{{\n');

		await writeConfigDirectory(makeConfig(), tmpDir);

		expect(await fs.readdir(rolesDir)).toEqual(['notes.yaml']);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('does not read as a config record'));
	});

	it('leaves a record whose declared identity does not match its filename', async () => {
		const rolesDir = path.join(tmpDir, 'roles');
		await fs.mkdir(rolesDir, { recursive: true });
		await fs.writeFile(path.join(rolesDir, 'notes.yaml'), dumpYaml({ key: 'something_else', name: 'Other' }));

		await writeConfigDirectory(makeConfig(), tmpDir);

		expect(await fs.readdir(rolesDir)).toEqual(['notes.yaml']);

		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('does not declare the identity its filename promises')
		);
	});

	it('aborts before writing anything when a document fails the structural checks', async () => {
		const config = makeConfig({
			roles: [{ key: 'editor', name: 'Editor', admin_access: false, app_access: true }],
		});

		const cyclic: Record<string, unknown> = {};
		cyclic['self'] = cyclic;
		(config.permissions as unknown[]).push({ role: 'editor', permissions: [{ permissions: cyclic }] });

		await expect(writeConfigDirectory(config, tmpDir)).rejects.toThrow(ConfigReadFailedException);

		await expect(fs.stat(path.join(tmpDir, 'cairncms-config.yaml'))).rejects.toThrow();
		await expect(fs.readdir(tmpDir)).resolves.toEqual([]);
	});

	it('leaves a previous tree intact when a later document fails the structural checks', async () => {
		const good = makeConfig({ roles: [{ key: 'editor', name: 'Editor', admin_access: false, app_access: true }] });
		await writeConfigDirectory(good, tmpDir);

		const before = await readYaml(path.join(tmpDir, 'roles', 'editor.yaml'));

		const broken = makeConfig({
			roles: [{ key: 'editor', name: 'Renamed', admin_access: false, app_access: true }],
		});

		(broken.permissions as unknown[]).push({
			role: 'editor',
			permissions: [{ permissions: { score: Number.POSITIVE_INFINITY } }],
		});

		await expect(writeConfigDirectory(broken, tmpDir)).rejects.toThrow(ConfigReadFailedException);

		expect(await readYaml(path.join(tmpDir, 'roles', 'editor.yaml'))).toEqual(before);
		await expect(fs.stat(path.join(tmpDir, 'permissions', 'editor.yaml'))).rejects.toThrow();
	});

	it('writes through a contained symlink to its target and leaves the link in place', async () => {
		const rolesDir = path.join(tmpDir, 'roles');
		await fs.mkdir(rolesDir, { recursive: true });

		const real = path.join(tmpDir, 'shared-editor.yaml');
		await fs.writeFile(real, 'placeholder\n');
		await fs.symlink(real, path.join(rolesDir, 'editor.yaml'));

		const config = makeConfig({
			roles: [{ key: 'editor', name: 'Editor', admin_access: false, app_access: true }],
		});

		await writeConfigDirectory(config, tmpDir);

		expect((await fs.lstat(path.join(rolesDir, 'editor.yaml'))).isSymbolicLink()).toBe(true);
		expect((await readYaml(real)).name).toBe('Editor');
	});

	it('refuses a destination whose link leaves the config directory', async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-outside-'));

		try {
			const escape = path.join(outside, 'editor.yaml');
			await fs.writeFile(escape, 'untouched\n');
			await fs.mkdir(path.join(tmpDir, 'roles'), { recursive: true });
			await fs.symlink(escape, path.join(tmpDir, 'roles', 'editor.yaml'));

			const config = makeConfig({
				roles: [{ key: 'editor', name: 'Editor', admin_access: false, app_access: true }],
			});

			await expect(writeConfigDirectory(config, tmpDir)).rejects.toThrow(ConfigInvalidException);
			await expect(fs.readFile(escape, 'utf8')).resolves.toBe('untouched\n');
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it('removes a stale symlinked record without touching its target', async () => {
		const rolesDir = path.join(tmpDir, 'roles');
		await fs.mkdir(rolesDir, { recursive: true });

		const real = path.join(tmpDir, 'shared-old.yaml');
		const original = dumpYaml({ key: 'old_role', name: 'Old' });
		await fs.writeFile(real, original);
		await fs.symlink(real, path.join(rolesDir, 'old_role.yaml'));

		await writeConfigDirectory(makeConfig(), tmpDir);

		expect(await fs.readdir(rolesDir)).toEqual([]);
		await expect(fs.readFile(real, 'utf8')).resolves.toBe(original);
	});

	it('produces byte-identical output when run twice', async () => {
		const config = makeConfig({
			roles: [
				{ key: 'editor', name: 'Editor', admin_access: false, app_access: true, ip_access: ['10.0.0.2', '10.0.0.1'] },
			],
			permissions: [
				{
					role: 'editor',
					permissions: [
						{
							collection: 'posts',
							action: 'read',
							permissions: null,
							validation: null,
							presets: null,
							fields: ['b', 'a'],
						},
					],
				},
			],
		});

		await writeConfigDirectory(config, tmpDir);
		const first = await fs.readFile(path.join(tmpDir, 'permissions', 'editor.yaml'), 'utf8');
		const firstRole = await fs.readFile(path.join(tmpDir, 'roles', 'editor.yaml'), 'utf8');

		await writeConfigDirectory(config, tmpDir);

		expect(await fs.readFile(path.join(tmpDir, 'permissions', 'editor.yaml'), 'utf8')).toBe(first);
		expect(await fs.readFile(path.join(tmpDir, 'roles', 'editor.yaml'), 'utf8')).toBe(firstRole);
	});

	it('aborts cleanup when a stale entry resolves outside the config directory', async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-outside-'));

		try {
			const escape = path.join(outside, 'old_role.yaml');
			const original = dumpYaml({ key: 'old_role', name: 'Old' });
			await fs.writeFile(escape, original);
			await fs.mkdir(path.join(tmpDir, 'roles'), { recursive: true });
			await fs.symlink(escape, path.join(tmpDir, 'roles', 'old_role.yaml'));

			await expect(writeConfigDirectory(makeConfig(), tmpDir)).rejects.toThrow(ConfigInvalidException);
			await expect(fs.readFile(escape, 'utf8')).resolves.toBe(original);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it('aborts cleanup when a stale entry cannot be read', async () => {
		await fs.mkdir(path.join(tmpDir, 'roles'), { recursive: true });
		await fs.writeFile(path.join(tmpDir, 'roles', 'old_role.yaml'), dumpYaml({ key: 'old_role' }));

		const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		const readFile = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(denied);

		try {
			await expect(writeConfigDirectory(makeConfig(), tmpDir)).rejects.toThrow(ConfigReadFailedException);
		} finally {
			readFile.mockRestore();
		}
	});

	it('aborts cleanup when a stale entry does not resolve', async () => {
		await fs.mkdir(path.join(tmpDir, 'roles'), { recursive: true });
		await fs.symlink(path.join(tmpDir, 'never-created.yaml'), path.join(tmpDir, 'roles', 'old_role.yaml'));

		await expect(writeConfigDirectory(makeConfig(), tmpDir)).rejects.toThrow(ConfigInvalidException);
	});

	it('leaves an unmanaged kind on disk untouched, even when the config carries records for it', async () => {
		await fs.mkdir(path.join(tmpDir, 'permissions'), { recursive: true });

		const survivor = path.join(tmpDir, 'permissions', 'editor.yaml');
		const contents = dumpYaml({ role: 'editor', permissions: [] });
		await fs.writeFile(survivor, contents);

		const config = makeConfig({
			manifest: { version: 1, resources: ['roles'] },
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

		expect(await fs.readFile(survivor, 'utf8')).toBe(contents);
	});

	it('does not create a directory for an unmanaged kind', async () => {
		const config = makeConfig({ manifest: { version: 1, resources: ['roles'] } });

		await writeConfigDirectory(config, tmpDir);

		expect(await fs.readdir(tmpDir)).toEqual(['cairncms-config.yaml', 'roles']);
	});
});
