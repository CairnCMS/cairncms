import { EXTENSION_PKG_KEY } from '@cairncms/constants';
import fse from 'fs-extra';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runAdd } from './src/cli/commands/add.js';

// runAdd takes the extension dir explicitly, so the test avoids process.chdir (which would disrupt sibling suites).
const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('inquirer', () => ({ default: { prompt } }));

vi.mock('execa', () => ({
	execa: vi.fn(async (file: string, args: string[] = []) =>
		file === 'npm' && args[0] === 'view'
			? { stdout: JSON.stringify({ 'dist-tags': { latest: '0.0.0' } }) }
			: { stdout: '', stderr: '' }
	),
}));

const testPrefix = 'temp-add';
let dir: string;

beforeEach(async () => {
	dir = resolve(process.cwd(), `${testPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	await fse.ensureDir(dir);
	prompt.mockReset();
});

afterEach(async () => {
	await fse.remove(dir);
});

function writeManifest(options: Record<string, unknown>, name = 'cairncms-extension-fixture') {
	return fse.writeJson(
		resolve(dir, 'package.json'),
		{ name, version: '1.0.0', type: 'module', [EXTENSION_PKG_KEY]: options },
		{ spaces: '\t' }
	);
}

describe('add mutates the bundle manifest and scaffolds entry sources', () => {
	test('appends interface then endpoint entries to an existing bundle', async () => {
		await writeManifest({
			type: 'bundle',
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			entries: [],
			host: '^1.0.0',
		});

		prompt.mockResolvedValueOnce({ type: 'interface', name: 'my-iface', language: 'javascript' });
		await runAdd(dir);

		prompt.mockResolvedValueOnce({ type: 'endpoint', name: 'my-ep', language: 'javascript' });
		await runAdd(dir);

		const options = (await fse.readJson(resolve(dir, 'package.json')))[EXTENSION_PKG_KEY];

		expect(options.entries).toEqual([
			{ type: 'interface', name: 'my-iface', source: 'src/my-iface/index.js' },
			{ type: 'endpoint', name: 'my-ep', source: 'src/my-ep/index.js' },
		]);

		expect(fse.pathExistsSync(resolve(dir, 'src', 'my-iface', 'index.js'))).toBe(true);
		expect(fse.pathExistsSync(resolve(dir, 'src', 'my-ep', 'index.js'))).toBe(true);
	});

	test('converts a single extension into a bundle, moving the original in as the first entry', async () => {
		await writeManifest(
			{ type: 'interface', path: 'dist/index.js', source: 'src/index.js', host: '^1.0.0' },
			'cairncms-extension-solo'
		);

		await fse.outputFile(resolve(dir, 'src', 'index.js'), 'export default {};\n');

		prompt.mockResolvedValueOnce({ proceed: true });

		prompt.mockResolvedValueOnce({
			type: 'endpoint',
			name: 'added-ep',
			language: 'javascript',
			convertName: 'solo',
			extensionName: 'combined',
		});

		await runAdd(dir);

		const manifest = await fse.readJson(resolve(dir, 'package.json'));
		const options = manifest[EXTENSION_PKG_KEY];

		expect(options.type).toBe('bundle');

		expect(options.entries).toEqual([
			{ type: 'interface', name: 'solo', source: 'src/solo/index.js' },
			{ type: 'endpoint', name: 'added-ep', source: 'src/added-ep/index.js' },
		]);

		expect(manifest.name).toBe('cairncms-extension-combined');
		expect(fse.pathExistsSync(resolve(dir, 'src', 'solo', 'index.js'))).toBe(true);
	});

	test('adds confined server entries with per-entry capabilities and a plain app entry to a confined bundle', async () => {
		await writeManifest(
			{
				type: 'bundle',
				path: { app: 'dist/app.js', api: 'dist/api.js' },
				entries: [],
				runtime: 'confined-server',
				host: '^1.0.0',
			},
			'cairncms-extension-confined-fixture'
		);

		prompt.mockResolvedValueOnce({ type: 'operation', name: 'my-op', language: 'typescript' });
		await runAdd(dir);

		prompt.mockResolvedValueOnce({ type: 'endpoint', name: 'my-ep', language: 'typescript' });
		await runAdd(dir);

		prompt.mockResolvedValueOnce({ type: 'hook', name: 'my-hook', language: 'typescript' });
		await runAdd(dir);

		prompt.mockResolvedValueOnce({ type: 'interface', name: 'my-iface', language: 'typescript' });
		await runAdd(dir);

		const manifest = await fse.readJson(resolve(dir, 'package.json'));
		const options = manifest[EXTENSION_PKG_KEY];

		expect(options.runtime).toBe('confined-server');

		// Server entries are confined with the minimal default capabilities, the app entry
		// stays a plain browser entry with none.
		expect(options.entries).toEqual([
			{
				type: 'operation',
				name: 'my-op',
				source: { app: 'src/my-op/app.ts', api: 'src/my-op/api.ts' },
				capabilities: { log: true },
			},
			{
				type: 'endpoint',
				name: 'my-ep',
				source: 'src/my-ep/index.ts',
				capabilities: { log: true, endpoint: { access: 'authenticated' } },
			},
			{
				type: 'hook',
				name: 'my-hook',
				source: 'src/my-hook/index.ts',
				capabilities: { log: true },
				events: { action: ['items.create'] },
			},
			{ type: 'interface', name: 'my-iface', source: 'src/my-iface/index.ts' },
		]);

		// A confined bundle's server entries author against the server API package.
		expect(manifest.devDependencies['@cairncms/extensions-server-api']).toBeDefined();

		// The identity contract: each confined server entry's source carries its own name,
		// the placeholder substituted.
		const opApi = await fse.readFile(resolve(dir, 'src', 'my-op', 'api.ts'), 'utf8');
		expect(opApi).toContain(`'my-op'`);
		expect(opApi).not.toContain('__extension_name__');

		const hookSource = await fse.readFile(resolve(dir, 'src', 'my-hook', 'index.ts'), 'utf8');
		expect(hookSource).toContain(`'my-hook'`);
		expect(hookSource).not.toContain('__extension_name__');
	});

	test('refuses to convert a confined extension into a bundle', async () => {
		await writeManifest(
			{
				type: 'operation',
				path: { app: 'dist/app.js', api: 'dist/api.js' },
				source: { app: 'src/app.ts', api: 'src/api.ts' },
				runtime: 'confined-server',
				capabilities: { log: true },
				host: '^1.0.0',
			},
			'cairncms-extension-confined-op'
		);

		await fse.outputFile(resolve(dir, 'src', 'app.ts'), 'export default {};\n');
		await fse.outputFile(resolve(dir, 'src', 'api.ts'), 'export default {};\n');

		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
			throw new Error('process.exit');
		}) as never);

		// The refusal happens before any prompt, so a confined extension is never silently
		// downgraded to a full-authority bundle.
		await expect(runAdd(dir)).rejects.toThrow('process.exit');
		expect(exitSpy).toHaveBeenCalledWith(1);

		const options = (await fse.readJson(resolve(dir, 'package.json')))[EXTENSION_PKG_KEY];
		expect(options.type).toBe('operation');
		expect(options.runtime).toBe('confined-server');

		exitSpy.mockRestore();
	});

	test('adds the typecheck script when a TypeScript entry is added to a bundle', async () => {
		await writeManifest({
			type: 'bundle',
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			entries: [],
			host: '^1.0.0',
		});

		prompt.mockResolvedValueOnce({ type: 'interface', name: 'ts-iface', language: 'typescript' });
		await runAdd(dir);

		const manifest = await fse.readJson(resolve(dir, 'package.json'));

		expect(manifest.devDependencies.typescript).toBeDefined();
		expect(manifest.scripts.typecheck).toBe('tsc --noEmit');
	});

	test('adds the typecheck script when converting to a bundle with a TypeScript entry', async () => {
		await writeManifest(
			{ type: 'interface', path: 'dist/index.js', source: 'src/index.js', host: '^1.0.0' },
			'cairncms-extension-solo'
		);

		await fse.outputFile(resolve(dir, 'src', 'index.js'), 'export default {};\n');

		prompt.mockResolvedValueOnce({ proceed: true });

		prompt.mockResolvedValueOnce({
			type: 'endpoint',
			name: 'ts-ep',
			language: 'typescript',
			convertName: 'solo',
			extensionName: 'combined',
		});

		await runAdd(dir);

		const manifest = await fse.readJson(resolve(dir, 'package.json'));

		expect(manifest.devDependencies.typescript).toBeDefined();
		expect(manifest.scripts.typecheck).toBe('tsc --noEmit');
	});
});
