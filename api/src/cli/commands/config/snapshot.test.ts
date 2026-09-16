import { promises as fs } from 'fs';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { transportRequestMock } = vi.hoisted(() => ({ transportRequestMock: vi.fn() }));

vi.mock('../../../database/index.js', () => ({
	default: vi.fn(),
	hasDatabaseConnection: vi.fn(),
	isInstalled: vi.fn(),
}));

vi.mock('../../../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock('./operator-remote-transport.js', () => ({
	createOperatorRemoteTransport: vi.fn(async () => ({ request: transportRequestMock })),
}));

vi.mock('../../../utils/get-config-snapshot.js', () => ({ readCurrentConfig: vi.fn() }));

import getDatabase, { hasDatabaseConnection, isInstalled } from '../../../database/index.js';
import logger from '../../../logger.js';
import { configSnapshot } from './snapshot.js';
import { readCurrentConfig } from '../../../utils/get-config-snapshot.js';

const TOKEN = 'sentinel-token';

const TOKEN_VARIABLES = ['CAIRNCMS_TOKEN', 'CAIRNCMS_TOKEN_FILE'] as const;

const MANIFEST = { version: 1, resources: ['roles', 'permissions'] };

const EDITOR = {
	key: 'editor',
	name: 'Editor',
	admin_access: false,
	app_access: true,
	icon: 'supervised_user_circle',
	enforce_tfa: false,
	description: null,
	ip_access: null,
};

const SETTINGS_DOC = {
	project_name: 'CairnCMS',
	project_descriptor: null,
	project_url: null,
	default_language: 'en-US',
	project_color: null,
	public_note: null,
	custom_css: null,
	module_bar: null,
	auth_password_policy: null,
	auth_login_attempts: 25,
	storage_asset_transform: 'all',
	storage_asset_presets: null,
	basemaps: null,
	custom_aspect_ratios: null,
	mapbox_key: null,
	storage_default_folder: null,
};

function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
	const copy = { ...obj };
	delete copy[key];
	return copy;
}

let tmpDir: string;
let savedEnv: Map<string, string | undefined>;

beforeEach(async () => {
	vi.clearAllMocks();
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-snapshot-'));
	savedEnv = new Map(TOKEN_VARIABLES.map((name) => [name, process.env[name]]));
	delete process.env['CAIRNCMS_TOKEN_FILE'];
	process.env['CAIRNCMS_TOKEN'] = TOKEN;

	vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterEach(async () => {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	vi.restoreAllMocks();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedDestination(): Promise<void> {
	await fs.mkdir(path.join(tmpDir, 'roles'), { recursive: true });
	await fs.writeFile(path.join(tmpDir, 'cairncms-config.yaml'), dumpYaml(MANIFEST));
	await fs.writeFile(path.join(tmpDir, 'roles', 'editor.yaml'), dumpYaml(EDITOR));
	await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'operator notes\n');
}

async function captureTree(dir: string): Promise<Map<string, string>> {
	const entries = new Map<string, string>();

	async function walk(current: string): Promise<void> {
		const children = await fs.readdir(current, { withFileTypes: true });

		for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, child.name);
			const relative = path.relative(dir, full);

			if (child.isDirectory()) {
				entries.set(`${relative}/`, '');
				await walk(full);
			} else {
				entries.set(relative, (await fs.readFile(full)).toString('base64'));
			}
		}
	}

	await walk(dir);

	return entries;
}

function respondWith(snapshot: unknown): void {
	transportRequestMock.mockImplementation(async (config: { url: string }) => {
		const { pathname } = new URL(config.url);

		if (pathname.endsWith('/server/info')) {
			return { status: 200, headers: {}, data: { data: { cairncms: { version: '1.6.0' } } } };
		}

		if (pathname.endsWith('/config/snapshot')) {
			return { status: 200, headers: {}, data: { data: snapshot } };
		}

		throw new Error(`unexpected request to ${pathname}`);
	});
}

describe('configSnapshot against a remote server', () => {
	it.each([
		['an unknown role field', { ...EDITOR, name: 'Renamed', external_id: 'sso-7' }, 'external_id'],
		['a role name in placeholder form', { ...EDITOR, name: '{{CAIRNCMS_CONFIG_SECRET}}' }, 'placeholder syntax'],
		['a role missing enforce_tfa', without(EDITOR, 'enforce_tfa'), 'enforce_tfa'],
	])(
		'leaves a pre-existing destination byte-for-byte unchanged when the snapshot carries %s',
		async (_label, role, detail) => {
			await seedDestination();
			const before = await captureTree(tmpDir);

			respondWith({ manifest: MANIFEST, roles: [role], permissions: [] });

			await configSnapshot(tmpDir, { yes: true, url: 'https://cms.example' });

			expect(vi.mocked(process.exit).mock.calls).toEqual([[3]]);
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining('malformed snapshot response'));
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining(detail));
			expect(await captureTree(tmpDir)).toEqual(before);
		}
	);

	it('refuses an incomplete snapshot into an empty destination and writes nothing', async () => {
		respondWith({
			manifest: { version: 2, resources: ['roles', 'permissions', 'folders', 'settings'] },
			roles: [without(EDITOR, 'enforce_tfa')],
			permissions: [],
			folders: [],
			settings: [SETTINGS_DOC],
		});

		await configSnapshot(tmpDir, { yes: true, url: 'https://cms.example' });

		expect(vi.mocked(process.exit).mock.calls).toEqual([[3]]);
		expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining('enforce_tfa'));
		expect(await fs.readdir(tmpDir)).toEqual([]);
	});

	it('writes a valid snapshot into the same destination', async () => {
		await seedDestination();

		respondWith({ manifest: MANIFEST, roles: [{ ...EDITOR, name: 'Renamed' }], permissions: [] });

		await configSnapshot(tmpDir, { yes: true, url: 'https://cms.example' });

		expect(vi.mocked(process.exit).mock.calls).toEqual([[0]]);
		expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
		expect(await fs.readFile(path.join(tmpDir, 'roles', 'editor.yaml'), 'utf8')).toContain('Renamed');
		expect(await fs.readFile(path.join(tmpDir, 'notes.txt'), 'utf8')).toBe('operator notes\n');
		expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.stringContaining('1 role(s), 0 permission set(s)'));
	});
});

describe('configSnapshot manifest version preservation', () => {
	async function seedManifest(version: number): Promise<void> {
		await fs.writeFile(
			path.join(tmpDir, 'cairncms-config.yaml'),
			dumpYaml({ version, resources: ['roles', 'permissions'] })
		);
	}

	async function writtenVersion(): Promise<number> {
		const parsed = loadYaml(await fs.readFile(path.join(tmpDir, 'cairncms-config.yaml'), 'utf8')) as {
			version: number;
		};

		return parsed.version;
	}

	describe('remote', () => {
		it.each([
			['an existing v1 directory', 1, 1],
			['an existing v2 directory', 2, 2],
			['a fresh directory', undefined, 2],
		])('sends and writes the expected version for %s', async (_label, seeded, expected) => {
			if (seeded !== undefined) await seedManifest(seeded);

			const respondedResources =
				seeded === undefined ? ['roles', 'permissions', 'folders', 'settings'] : ['roles', 'permissions'];

			respondWith({
				manifest: { version: expected, resources: respondedResources },
				roles: [],
				permissions: [],
				...(expected >= 2 ? { folders: [], settings: seeded === undefined ? [SETTINGS_DOC] : [] } : {}),
			});

			await configSnapshot(tmpDir, { yes: true, url: 'https://cms.example' });

			expect(vi.mocked(process.exit).mock.calls).toEqual([[0]]);

			const snapshotCall = transportRequestMock.mock.calls.find(([config]) =>
				new URL((config as { url: string }).url).pathname.endsWith('/config/snapshot')
			);

			expect((snapshotCall![0] as { params: Record<string, string> }).params.manifest_version).toBe(String(expected));

			expect(await writtenVersion()).toBe(expected);
		});
	});

	describe('local', () => {
		beforeEach(() => {
			vi.mocked(getDatabase).mockReturnValue({ destroy: vi.fn() } as never);
			vi.mocked(hasDatabaseConnection).mockResolvedValue(true);
			vi.mocked(isInstalled).mockResolvedValue(true);

			vi.mocked(readCurrentConfig).mockImplementation(
				async (options) =>
					({
						config: {
							manifest: { version: options.manifestVersion ?? 2, resources: [...options.resources] },
							roles: [],
							permissions: [],
							folders: [],
							settings: options.resources.includes('settings') ? [SETTINGS_DOC] : [],
						},
						currentRoleKeys: new Set<string>(),
						stateToken: { resources: [...options.resources], digest: 'digest' },
					} as never)
			);
		});

		it.each([
			['an existing v1 directory', 1, 1],
			['an existing v2 directory', 2, 2],
			['a fresh directory', undefined, 2],
		])('writes the expected version for %s', async (_label, seeded, expected) => {
			if (seeded !== undefined) await seedManifest(seeded);

			await configSnapshot(tmpDir, { yes: true });

			expect(vi.mocked(process.exit).mock.calls).toEqual([[0]]);
			expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
			expect(await writtenVersion()).toBe(expected);
		});
	});
});

describe('configSnapshot placeholder preservation', () => {
	const RESOLVED_EDITOR = { ...EDITOR, name: 'Resolved Name' };

	async function seedPlaceholder(): Promise<void> {
		await fs.mkdir(path.join(tmpDir, 'roles'), { recursive: true });
		await fs.writeFile(path.join(tmpDir, 'cairncms-config.yaml'), dumpYaml(MANIFEST));

		await fs.writeFile(
			path.join(tmpDir, 'roles', 'editor.yaml'),
			dumpYaml({ ...EDITOR, name: '{{CAIRNCMS_CONFIG_ROLE_NAME}}' })
		);
	}

	async function writtenRoleName(): Promise<unknown> {
		const parsed = loadYaml(await fs.readFile(path.join(tmpDir, 'roles', 'editor.yaml'), 'utf8')) as { name: unknown };
		return parsed.name;
	}

	it('preserves a committed placeholder on a remote snapshot', async () => {
		await seedPlaceholder();
		respondWith({ manifest: MANIFEST, roles: [RESOLVED_EDITOR], permissions: [] });

		await configSnapshot(tmpDir, { yes: true, url: 'https://cms.example' });

		expect(vi.mocked(process.exit).mock.calls).toEqual([[0]]);
		expect(await writtenRoleName()).toBe('{{CAIRNCMS_CONFIG_ROLE_NAME}}');
	});

	it('preserves a committed placeholder on a local snapshot', async () => {
		vi.mocked(getDatabase).mockReturnValue({ destroy: vi.fn() } as never);
		vi.mocked(hasDatabaseConnection).mockResolvedValue(true);
		vi.mocked(isInstalled).mockResolvedValue(true);

		vi.mocked(readCurrentConfig).mockResolvedValue({
			config: { manifest: MANIFEST, roles: [RESOLVED_EDITOR], permissions: [], folders: [], settings: [] },
			currentRoleKeys: new Set<string>(),
			currentFolderKeys: new Set<string>(),
			currentFolderParents: new Map<string, string | null>(),
			stateToken: { resources: ['roles', 'permissions'], digest: 'digest' },
		} as never);

		await seedPlaceholder();

		await configSnapshot(tmpDir, { yes: true });

		expect(vi.mocked(process.exit).mock.calls).toEqual([[0]]);
		expect(await writtenRoleName()).toBe('{{CAIRNCMS_CONFIG_ROLE_NAME}}');
	});
});
