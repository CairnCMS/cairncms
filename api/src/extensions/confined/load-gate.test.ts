import type { Extension } from '@cairncms/types';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gateConfinedExtension, MAX_MANIFEST_BYTES } from './load-gate.js';

const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

const CLEAN_SOURCE = 'export default {};\n';
const RAW_FS_SOURCE = "import { readFile } from 'node:fs/promises';\nexport default {};\n";
const BROWSER_FETCH_SOURCE = 'export default { run: () => fetch("https://example.com") };\n';

async function makeDir(manifest: unknown, files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'cairn-gate-'));
	created.push(dir);

	const manifestText = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
	await writeFile(path.join(dir, 'package.json'), manifestText);

	for (const [relative, content] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
		await writeFile(path.join(dir, relative), content);
	}

	return dir;
}

function manifest(options: Record<string, unknown>): Record<string, unknown> {
	return { name: 'test-extension', version: '1.0.0', 'cairncms:extension': options };
}

function endpointManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return manifest({
		type: 'endpoint',
		path: 'dist/index.js',
		source: 'src/index.js',
		runtime: 'confined-server',
		host: '^10.0.0',
		...overrides,
	});
}

function extensionAt(dir: string, type: 'endpoint' | 'operation' | 'bundle' = 'endpoint'): Extension {
	const base = { path: dir, name: 'test-extension', local: true, runtime: 'confined-server' as const };

	if (type === 'endpoint') return { ...base, type, entrypoint: 'dist/index.js' };

	if (type === 'operation') {
		return { ...base, type, entrypoint: { app: 'dist/app.js', api: 'dist/api.js' } };
	}

	return {
		...base,
		type: 'bundle',
		entrypoint: { app: 'dist/app.js', api: 'dist/api.js' },
		entries: [
			{ type: 'endpoint', name: 'ep' },
			{ type: 'interface', name: 'ui' },
		],
	};
}

describe('gateConfinedExtension', () => {
	it('passes a clean confined endpoint', async () => {
		const dir = await makeDir(endpointManifest(), { 'src/index.js': CLEAN_SOURCE });
		expect(await gateConfinedExtension(extensionAt(dir))).toEqual({ ok: true });
	});

	it('refuses flagged source with the reason code and a relative detail', async () => {
		const dir = await makeDir(endpointManifest(), { 'src/index.js': RAW_FS_SOURCE });
		const verdict = await gateConfinedExtension(extensionAt(dir));

		expect(verdict.ok).toBe(false);

		if (!verdict.ok) {
			expect(verdict.error.code).toBe('uses-raw-fs');
			expect(verdict.error.detail).toContain('index.js');
			expect(verdict.error.detail).not.toContain(dir);
		}
	});

	it('refuses a confined extension whose declared source does not exist', async () => {
		const dir = await makeDir(endpointManifest(), {});
		const verdict = await gateConfinedExtension(extensionAt(dir));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'source-unavailable' } });
	});

	it('refuses an over-cap manifest without parsing it', async () => {
		const padded = JSON.stringify({
			...endpointManifest(),
			padding: 'x'.repeat(MAX_MANIFEST_BYTES),
		});

		const dir = await makeDir(padded, { 'src/index.js': CLEAN_SOURCE });
		const verdict = await gateConfinedExtension(extensionAt(dir));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'manifest-too-large' } });
	});

	it('refuses a manifest that is not valid JSON', async () => {
		const dir = await makeDir('{ not json', { 'src/index.js': CLEAN_SOURCE });
		const verdict = await gateConfinedExtension(extensionAt(dir));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'manifest-invalid' } });
	});

	it('refuses a manifest that fails schema validation', async () => {
		const options = endpointManifest();
		delete (options['cairncms:extension'] as Record<string, unknown>)['host'];
		const dir = await makeDir(options, { 'src/index.js': CLEAN_SOURCE });
		const verdict = await gateConfinedExtension(extensionAt(dir));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'manifest-invalid' } });
	});

	it('refuses when the re-read manifest no longer declares a confined runtime', async () => {
		const options = endpointManifest();
		delete (options['cairncms:extension'] as Record<string, unknown>)['runtime'];
		const dir = await makeDir(options, { 'src/index.js': CLEAN_SOURCE });
		const verdict = await gateConfinedExtension(extensionAt(dir));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'manifest-invalid' } });
	});

	it('refuses when the re-read manifest name differs from the discovered name', async () => {
		const dir = await makeDir({ ...endpointManifest(), name: 'renamed-extension' }, { 'src/index.js': CLEAN_SOURCE });
		const verdict = await gateConfinedExtension(extensionAt(dir));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'manifest-invalid' } });
	});

	it('refuses when the re-read manifest type differs from the discovered type', async () => {
		const operationManifest = manifest({
			type: 'operation',
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			source: { app: 'src/app.js', api: 'src/api.js' },
			runtime: 'confined-server',
			host: '^10.0.0',
		});

		const dir = await makeDir(operationManifest, { 'src/api.js': CLEAN_SOURCE });
		const verdict = await gateConfinedExtension(extensionAt(dir, 'endpoint'));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'manifest-invalid' } });
	});

	it('refuses when the re-read manifest entrypoint differs from the discovered entrypoint', async () => {
		const dir = await makeDir(endpointManifest({ path: 'dist/other.js' }), { 'src/index.js': CLEAN_SOURCE });
		const verdict = await gateConfinedExtension(extensionAt(dir));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'manifest-invalid' } });
	});

	it('refuses when the re-read bundle entries differ from the discovered entries', async () => {
		const bundleManifest = manifest({
			type: 'bundle',
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			entries: [
				{ type: 'endpoint', name: 'renamed-entry', source: 'src/ep.js' },
				{ type: 'interface', name: 'ui', source: 'src/ui.js' },
			],
			runtime: 'confined-server',
			host: '^10.0.0',
		});

		const dir = await makeDir(bundleManifest, { 'src/ep.js': CLEAN_SOURCE, 'src/ui.js': CLEAN_SOURCE });
		const verdict = await gateConfinedExtension(extensionAt(dir, 'bundle'));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'manifest-invalid' } });
	});

	it('scans a hybrid operation server source and not its app source', async () => {
		const operationManifest = manifest({
			type: 'operation',
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			source: { app: 'src/app.js', api: 'src/api.js' },
			runtime: 'confined-server',
			host: '^10.0.0',
		});

		const passing = await makeDir(operationManifest, {
			'src/app.js': BROWSER_FETCH_SOURCE,
			'src/api.js': CLEAN_SOURCE,
		});

		expect(await gateConfinedExtension(extensionAt(passing, 'operation'))).toEqual({ ok: true });

		const failing = await makeDir(operationManifest, {
			'src/app.js': CLEAN_SOURCE,
			'src/api.js': RAW_FS_SOURCE,
		});

		const verdict = await gateConfinedExtension(extensionAt(failing, 'operation'));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'uses-raw-fs' } });
	});

	it('scans a bundle server-entry source and not its app-entry source', async () => {
		const bundleManifest = (endpointSource: string) =>
			manifest({
				type: 'bundle',
				path: { app: 'dist/app.js', api: 'dist/api.js' },
				entries: [
					{ type: 'endpoint', name: 'ep', source: endpointSource },
					{ type: 'interface', name: 'ui', source: 'src/ui.js' },
				],
				runtime: 'confined-server',
				host: '^10.0.0',
			});

		const passing = await makeDir(bundleManifest('src/ep.js'), {
			'src/ep.js': CLEAN_SOURCE,
			'src/ui.js': BROWSER_FETCH_SOURCE,
		});

		expect(await gateConfinedExtension(extensionAt(passing, 'bundle'))).toEqual({ ok: true });

		const failing = await makeDir(bundleManifest('src/ep.js'), {
			'src/ep.js': RAW_FS_SOURCE,
			'src/ui.js': CLEAN_SOURCE,
		});

		const verdict = await gateConfinedExtension(extensionAt(failing, 'bundle'));
		expect(verdict).toMatchObject({ ok: false, error: { code: 'uses-raw-fs' } });
	});

	it('collapses an unsafe reason message to a generic detail', async () => {
		const dir = await makeDir(endpointManifest(), { 'src/index.js': CLEAN_SOURCE });

		const absolute = await gateConfinedExtension(extensionAt(dir), {
			scan: async () => ({
				reasons: [{ code: 'uses-raw-fs', message: `detected in ${path.join(dir, 'src/index.js')}` }],
				sourceFiles: [],
			}),
		});

		expect(absolute).toMatchObject({ ok: false, error: { code: 'uses-raw-fs', detail: 'confined validation failed' } });

		const traversal = await gateConfinedExtension(extensionAt(dir), {
			scan: async () => ({
				reasons: [{ code: 'local-path-escapes-root', message: 'detected in ../outside.js' }],
				sourceFiles: [],
			}),
		});

		expect(traversal).toMatchObject({ ok: false, error: { detail: 'confined validation failed' } });

		const relative = await gateConfinedExtension(extensionAt(dir), {
			scan: async () => ({
				reasons: [{ code: 'uses-raw-fs', message: 'detected in src/index.js' }],
				sourceFiles: [],
			}),
		});

		expect(relative).toMatchObject({ ok: false, error: { detail: 'detected in src/index.js' } });
	});
});
