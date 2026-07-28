import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { dump as toYaml } from 'js-yaml';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import { ConfigUnsupportedVersionException } from '../exceptions/config-unsupported-version.js';
import logger from '../logger.js';
import { computeConfigPlan } from './compute-config-plan.js';
import { readConfigDirectory } from './read-config-directory.js';

vi.mock('../logger.js', () => ({
	default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-read-test-'));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function captureRejection(run: () => Promise<unknown>): Promise<any> {
	try {
		await run();
	} catch (err) {
		return err;
	}

	throw new Error('expected the call to reject');
}

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

	it('treats a missing manifest as invalid input rather than an empty configuration', async () => {
		await expect(readConfigDirectory(tmpDir)).rejects.toThrow(ConfigInvalidException);
		await expect(readConfigDirectory(tmpDir)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('cairncms-config.yaml');
	});

	it('reports an unreadable manifest as a read failure rather than a missing one', async () => {
		await writeManifest();

		const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		const readFile = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(denied);

		try {
			await expect(readConfigDirectory(tmpDir)).rejects.toMatchObject({ code: 'CONFIG_READ_FAILED' });
		} finally {
			readFile.mockRestore();
		}
	});

	it('throws on unsupported version', async () => {
		await fs.writeFile(path.join(tmpDir, 'cairncms-config.yaml'), toYaml({ version: 99, resources: [] }));

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow(ConfigUnsupportedVersionException);
		await expect(readConfigDirectory(tmpDir)).rejects.toMatchObject({ code: 'CONFIG_UNSUPPORTED_VERSION' });
		await expect(readConfigDirectory(tmpDir)).rejects.toThrow('declares version 99');
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

	it('substitutes variables inside the supported namespace', async () => {
		vi.stubEnv('CAIRNCMS_CONFIG_ROLE_NAME', 'Interpolated Name');
		vi.stubEnv('CAIRNCMS_CONFIG_ROLE_DESC', 'Interpolated Description');

		await writeManifest();

		await writeRole('editor', {
			name: '{{CAIRNCMS_CONFIG_ROLE_NAME}}',
			description: '{{CAIRNCMS_CONFIG_ROLE_DESC}}',
		});

		const config = await readConfigDirectory(tmpDir);

		expect(config.roles[0]!.name).toBe('Interpolated Name');
		expect(config.roles[0]!.description).toBe('Interpolated Description');
	});

	it('refuses a variable outside the supported namespace instead of reading it', async () => {
		for (const varName of ['DATABASE_PASSWORD', 'SECRET']) {
			vi.stubEnv(varName, 'a-real-secret-value');

			await writeManifest();
			await writeRole('editor', { name: `{{${varName}}}` });

			const error = await captureRejection(() => readConfigDirectory(tmpDir));

			expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
			expect(error.message).toContain(varName);
			expect(error.message).not.toContain('a-real-secret-value');
		}
	});

	it('refuses an in-namespace variable with no value, naming the variable, role, and field', async () => {
		vi.stubEnv('CAIRNCMS_CONFIG_MISSING', undefined);

		await writeManifest();
		await writeRole('editor', { description: '{{CAIRNCMS_CONFIG_MISSING}}' });

		const error = await captureRejection(() => readConfigDirectory(tmpDir));

		expect(error).toMatchObject({ code: 'CONFIG_PLACEHOLDER_UNRESOLVED' });
		expect(error.message).toContain('CAIRNCMS_CONFIG_MISSING');
		expect(error.message).toContain('editor');
		expect(error.message).toContain('description');
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

	it('aborts on a roles directory whose link does not resolve, rather than reporting no roles', async () => {
		await writeManifest();
		await fs.symlink(path.join(tmpDir, 'never-created'), path.join(tmpDir, 'roles'));

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow(ConfigInvalidException);
	});

	it('aborts when a roles directory cannot be listed', async () => {
		await writeManifest();
		await writeRole('editor');

		const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		const readdir = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(denied);

		try {
			await expect(readConfigDirectory(tmpDir)).rejects.toThrow(ConfigReadFailedException);
		} finally {
			readdir.mockRestore();
		}
	});

	it('aborts when a file sits where a kind directory belongs', async () => {
		await writeManifest();
		await fs.writeFile(path.join(tmpDir, 'roles'), 'not a directory\n');

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow(ConfigInvalidException);
	});

	it('refuses a manifest that is a link out of the config directory', async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-outside-'));

		try {
			await fs.writeFile(path.join(outside, 'manifest.yaml'), toYaml({ version: 1, resources: [] }));
			await fs.symlink(path.join(outside, 'manifest.yaml'), path.join(tmpDir, 'cairncms-config.yaml'));

			await expect(readConfigDirectory(tmpDir)).rejects.toThrow(ConfigInvalidException);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it('refuses a manifest whose link does not resolve', async () => {
		await fs.symlink(path.join(tmpDir, 'gone.yaml'), path.join(tmpDir, 'cairncms-config.yaml'));

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow(ConfigInvalidException);
	});

	it('refuses a manifest that is a directory', async () => {
		await fs.mkdir(path.join(tmpDir, 'cairncms-config.yaml'));

		await expect(readConfigDirectory(tmpDir)).rejects.toThrow(ConfigInvalidException);
	});

	it('names the file for an unparsable record without echoing its contents', async () => {
		await writeManifest(['roles']);
		await fs.mkdir(path.join(tmpDir, 'roles'), { recursive: true });
		await fs.writeFile(path.join(tmpDir, 'roles', 'editor.yaml'), 'key: editor\ntoken: "s3cret-value\n');

		let message = '';

		try {
			await readConfigDirectory(tmpDir);
		} catch (err) {
			message = (err as Error).message;
		}

		expect(message).toContain('roles/editor.yaml');
		expect(message).not.toContain('s3cret-value');
	});

	it('ignores a file the engine does not generate, including when it is a link', async () => {
		await writeManifest(['roles']);
		await writeRole('editor');
		await fs.writeFile(path.join(tmpDir, 'README.md'), '# notes\n');
		await fs.writeFile(path.join(tmpDir, 'notes-source.md'), '# more notes\n');
		await fs.symlink(path.join(tmpDir, 'notes-source.md'), path.join(tmpDir, 'roles', 'README.md'));

		const config = await readConfigDirectory(tmpDir);

		expect(config.roles.map((r) => r.key)).toEqual(['editor']);
	});

	it('ignores a record filename the engine would have stored under a different key', async () => {
		await writeManifest(['roles']);
		await writeRole('editor');
		await fs.writeFile(path.join(tmpDir, 'roles', 'Editor.yaml'), toYaml({ key: 'Editor', name: 'Editor' }));

		const config = await readConfigDirectory(tmpDir);

		expect(config.roles.map((r) => r.key)).toEqual(['editor']);
	});

	it('sanitizes a rejected filename before it reaches a diagnostic', async () => {
		await writeManifest(['roles']);
		await fs.mkdir(path.join(tmpDir, 'roles'), { recursive: true });
		const hostile = `edi${String.fromCharCode(1)}tor${String.fromCharCode(27)}[31m.yaml`;
		await fs.writeFile(path.join(tmpDir, 'roles', hostile), toYaml({ key: 'editor' }));

		const notices: string[] = [];
		await readConfigDirectory(tmpDir, { notice: (message) => notices.push(message) });

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('edi?tor?[31m.yaml');
		expect(notices[0]).not.toContain(String.fromCharCode(1));
		expect(notices[0]).not.toContain(String.fromCharCode(27));
	});

	it('sends read-path notices to the caller instead of the log stream when one is supplied', async () => {
		await writeManifest(['roles', 'permissions']);
		await writeRole('editor');

		const notices: string[] = [];
		vi.mocked(logger.warn).mockClear();

		await readConfigDirectory(tmpDir, { notice: (message) => notices.push(message) });

		expect(notices).toEqual(['No permissions/ directory in the config tree; treating permissions as empty.']);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('carries a date-like scalar and a merge-key filter through to the plan', async () => {
		await writeManifest(['roles', 'permissions']);
		await writeRole('editor');
		await fs.mkdir(path.join(tmpDir, 'permissions'), { recursive: true });

		await fs.writeFile(
			path.join(tmpDir, 'permissions', 'editor.yaml'),
			[
				'role: editor',
				'permissions:',
				'  - collection: articles',
				'    action: read',
				'    fields: ["*"]',
				'    validation: null',
				'    presets: null',
				'    permissions: &shared',
				'      status: published',
				'      published_on: 2024-01-01',
				'  - collection: comments',
				'    action: read',
				'    fields: ["*"]',
				'    validation: null',
				'    presets: null',
				'    permissions:',
				'      <<: *shared',
				'      approved: true',
				'',
			].join('\n')
		);

		const desired = await readConfigDirectory(tmpDir);
		const plan = computeConfigPlan({ manifest: desired.manifest, roles: [], permissions: [] }, desired);

		const planned = plan.permissions.create.map((entry) => entry.permission.permissions);

		expect(planned).toEqual([
			{ status: 'published', published_on: '2024-01-01T00:00:00.000Z' },
			{ status: 'published', published_on: '2024-01-01T00:00:00.000Z', approved: true },
		]);
	});
});
