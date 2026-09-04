import { promises as fs } from 'fs';
import { dump as dumpYaml } from 'js-yaml';
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

import logger from '../../../logger.js';
import { configSnapshot } from './snapshot.js';

const TOKEN = 'sentinel-token';

const TOKEN_VARIABLES = ['CAIRNCMS_TOKEN', 'CAIRNCMS_TOKEN_FILE'] as const;

const MANIFEST = { version: 1, resources: ['roles', 'permissions'] };

const EDITOR = { key: 'editor', name: 'Editor', admin_access: false, app_access: true };

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
