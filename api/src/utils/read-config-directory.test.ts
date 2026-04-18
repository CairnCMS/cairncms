import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { dump as toYaml } from 'js-yaml';
import { readConfigDirectory } from './read-config-directory.js';

vi.mock('../logger.js', () => ({
	default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-read-test-'));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeManifest(resources: string[] = ['roles', 'permissions']): Promise<void> {
	await fs.writeFile(path.join(tmpDir, 'cairncms-config.yaml'), toYaml({ version: 1, resources }));
}

async function writeRole(key: string, data?: Record<string, any>): Promise<void> {
	const rolesDir = path.join(tmpDir, 'roles');
	await fs.mkdir(rolesDir, { recursive: true });

	await fs.writeFile(
		path.join(rolesDir, `${key}.yaml`),
		toYaml({ key, name: key.charAt(0).toUpperCase() + key.slice(1), admin_access: false, app_access: true, ...data })
	);
}

async function writePermissions(role: string, permissions: any[] = []): Promise<void> {
	const permDir = path.join(tmpDir, 'permissions');
	await fs.mkdir(permDir, { recursive: true });
	await fs.writeFile(path.join(permDir, `${role}.yaml`), toYaml({ role, permissions }));
}

describe('readConfigDirectory', () => {
	it('reads a valid config directory', async () => {
		await writeManifest();
		await writeRole('editor');

		await writePermissions('editor', [
			{ collection: 'articles', action: 'read', permissions: null, validation: null, presets: null, fields: null },
		]);

		const config = await readConfigDirectory(tmpDir);

		expect(config.manifest.version).toBe(1);
		expect(config.roles).toHaveLength(1);
		expect(config.roles[0]!.key).toBe('editor');
		expect(config.permissions).toHaveLength(1);
		expect(config.permissions[0]!.permissions).toHaveLength(1);
	});

	it('throws on missing manifest', async () => {
		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('Config manifest not found');
	});

	it('throws on unsupported version', async () => {
		await fs.writeFile(path.join(tmpDir, 'cairncms-config.yaml'), toYaml({ version: 99, resources: [] }));
		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('Unsupported config version');
	});

	it('throws on missing resources array', async () => {
		await fs.writeFile(path.join(tmpDir, 'cairncms-config.yaml'), toYaml({ version: 1 }));
		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('must declare a "resources" array');
	});

	it('throws when role file key does not match filename', async () => {
		await writeManifest();
		const rolesDir = path.join(tmpDir, 'roles');
		await fs.mkdir(rolesDir, { recursive: true });

		await fs.writeFile(
			path.join(rolesDir, 'wrong.yaml'),
			toYaml({ key: 'editor', name: 'Editor', admin_access: false, app_access: true })
		);

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('filename must match key');
	});

	it('throws when role file is missing key field', async () => {
		await writeManifest();
		const rolesDir = path.join(tmpDir, 'roles');
		await fs.mkdir(rolesDir, { recursive: true });
		await fs.writeFile(path.join(rolesDir, 'bad.yaml'), toYaml({ name: 'Bad' }));

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('missing "key" field');
	});

	it('throws when permission file references a non-existent role', async () => {
		await writeManifest();
		await writePermissions('ghost', []);

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('no matching file in roles/');
	});

	it('allows permissions/public.yaml without a matching role file', async () => {
		await writeManifest();

		await writePermissions('public', [
			{ collection: 'articles', action: 'read', permissions: null, validation: null, presets: null, fields: null },
		]);

		const config = await readConfigDirectory(tmpDir);

		expect(config.permissions).toHaveLength(1);
		expect(config.permissions[0]!.role).toBe('public');
	});

	it('interpolates env vars in role name and description', async () => {
		process.env['TEST_ROLE_NAME'] = 'Interpolated Name';
		process.env['TEST_ROLE_DESC'] = 'Interpolated Description';

		await writeManifest();
		await writeRole('editor', { name: '{{TEST_ROLE_NAME}}', description: '{{TEST_ROLE_DESC}}' });

		const config = await readConfigDirectory(tmpDir);

		expect(config.roles[0]!.name).toBe('Interpolated Name');
		expect(config.roles[0]!.description).toBe('Interpolated Description');

		delete process.env['TEST_ROLE_NAME'];
		delete process.env['TEST_ROLE_DESC'];
	});

	it('leaves unresolved env vars as literals with warning', async () => {
		await writeManifest();
		await writeRole('editor', { name: '{{NONEXISTENT_VAR}}' });

		const config = await readConfigDirectory(tmpDir);

		expect(config.roles[0]!.name).toBe('{{NONEXISTENT_VAR}}');
	});

	it('does not interpolate partial env var patterns', async () => {
		await writeManifest();
		await writeRole('editor', { name: 'prefix {{VAR}} suffix' });

		const config = await readConfigDirectory(tmpDir);

		expect(config.roles[0]!.name).toBe('prefix {{VAR}} suffix');
	});

	it('skips non-.yaml files', async () => {
		await writeManifest();
		const rolesDir = path.join(tmpDir, 'roles');
		await fs.mkdir(rolesDir, { recursive: true });
		await fs.writeFile(path.join(rolesDir, 'README.md'), 'not a role');
		await writeRole('editor');

		const config = await readConfigDirectory(tmpDir);

		expect(config.roles).toHaveLength(1);
	});

	it('rejects roles/public.yaml as reserved key', async () => {
		await writeManifest();
		await writeRole('public');

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('reserved for public permissions');
	});

	it('throws when permission file role does not match filename', async () => {
		await writeManifest();
		await writeRole('editor');
		const permDir = path.join(tmpDir, 'permissions');
		await fs.mkdir(permDir, { recursive: true });
		await fs.writeFile(path.join(permDir, 'wrong.yaml'), toYaml({ role: 'editor', permissions: [] }));

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('filename must match role');
	});

	it('throws when permissions field is not an array', async () => {
		await writeManifest();
		await writeRole('editor');
		const permDir = path.join(tmpDir, 'permissions');
		await fs.mkdir(permDir, { recursive: true });
		await fs.writeFile(path.join(permDir, 'editor.yaml'), toYaml({ role: 'editor', permissions: {} }));

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('"permissions" must be an array');
	});

	it('handles empty roles and permissions directories', async () => {
		await writeManifest();
		await fs.mkdir(path.join(tmpDir, 'roles'), { recursive: true });
		await fs.mkdir(path.join(tmpDir, 'permissions'), { recursive: true });

		const config = await readConfigDirectory(tmpDir);

		expect(config.roles).toEqual([]);
		expect(config.permissions).toEqual([]);
	});
});
