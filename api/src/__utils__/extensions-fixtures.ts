import type { Extension } from '@cairncms/types';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExtensionManager } from '../extensions.js';
import { filterServerExtensions } from '../utils/filter-server-extensions.js';

// The temp dir the fixtures write into, owned here and shared by every helper. Each test
// file also stores the value `createExtensionFixtures` returns, so `path.join(root, ...)` in
// a test body reads the same directory. Set only inside `createExtensionFixtures`.
let root: string;

export function writeThrowingEntry(dir: string, file: string, marker: string): void {
	const full = path.join(root, dir);
	mkdirSync(full, { recursive: true });
	writeFileSync(path.join(full, file), `throw new Error(${JSON.stringify(marker)});\n`);
}

/**
 * A complete confined endpoint or hook package the load gate can read: a valid
 * manifest declaring the confined runtime, the declared source file, and for an
 * endpoint a built entry. The built entry doubles as the never-imported canary:
 * it throws a marker under Node, where `process` exists, while the probe's
 * QuickJS guest sees a valid CairnEndpoint config.
 */
export function writeConfinedPackage(
	dir: string,
	source: string,
	name = dir,
	capabilities?: Record<string, unknown>,
	type: 'endpoint' | 'hook' = 'endpoint',
	events: { filter?: string[]; action?: string[] } = { action: ['server.start'] }
): void {
	const full = path.join(root, dir);
	mkdirSync(path.join(full, 'src'), { recursive: true });

	writeFileSync(
		path.join(full, 'package.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			'cairncms:extension': {
				type,
				path: 'index.js',
				source: 'src/index.js',
				runtime: 'confined-server',
				host: '^10.0.0',
				...(capabilities && { capabilities }),
				...(type === 'hook' && { events }),
			},
		})
	);

	writeFileSync(path.join(full, 'src', 'index.js'), source);

	const handlers = (names: string[] | undefined) =>
		(names ?? []).map((event) => `${JSON.stringify(event)}: () => undefined`).join(', ');

	const guestEntry =
		type === 'endpoint'
			? `var CairnEndpoint = (() => { const handler = async () => ({ body: null }); return { default: { id: ${JSON.stringify(
					name
			  )}, handler } }; })();\n`
			: `var CairnHook = (() => ({ default: { id: ${JSON.stringify(name)}, filters: { ${handlers(
					events.filter
			  )} }, actions: { ${handlers(events.action)} } } }))();\n`;

	writeFileSync(
		path.join(full, 'index.js'),
		`if (typeof process !== 'undefined') { throw new Error('CONFINED_ENDPOINT_IMPORTED'); }\n${guestEntry}`
	);
}

/**
 * A complete confined operation package: a hybrid manifest, clean app and api
 * source, and a built api entry whose config id equals the extension name.
 */
export function writeConfinedOperationPackage(dir: string, name = dir): void {
	const full = path.join(root, dir);
	mkdirSync(path.join(full, 'src'), { recursive: true });

	writeFileSync(
		path.join(full, 'package.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			'cairncms:extension': {
				type: 'operation',
				path: { app: 'app.js', api: 'api.js' },
				source: { app: 'src/app.js', api: 'src/api.js' },
				runtime: 'confined-server',
				host: '^10.0.0',
			},
		})
	);

	writeFileSync(path.join(full, 'src', 'app.js'), 'export default {};\n');
	writeFileSync(path.join(full, 'src', 'api.js'), 'export default {};\n');

	writeFileSync(
		path.join(full, 'api.js'),
		`var CairnOperation = (() => { const handler = async () => ({ ok: true }); return { default: { id: ${JSON.stringify(
			name
		)}, handler } }; })();\n`
	);
}

/**
 * A complete confined bundle package with one server entry and the given server
 * entry source, matching the discovered bundle shape.
 */
export function writeConfinedBundlePackage(dir: string, serverEntrySource: string, name = dir): void {
	const full = path.join(root, dir);
	mkdirSync(path.join(full, 'src'), { recursive: true });

	writeFileSync(
		path.join(full, 'package.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			'cairncms:extension': {
				type: 'bundle',
				path: { app: 'app.js', api: 'api.js' },
				entries: [{ type: 'endpoint', name: `${name}-endpoint`, source: 'src/ep.js' }],
				runtime: 'confined-server',
				host: '^10.0.0',
			},
		})
	);

	writeFileSync(path.join(full, 'src', 'ep.js'), serverEntrySource);

	// The built bundle artifact the gate reads and probes, exposing the one endpoint
	// entry under its `type:name` key.
	const entryName = `${name}-endpoint`;

	writeFileSync(
		path.join(full, 'api.js'),
		`var CairnBundle = (() => ({ default: { ${JSON.stringify(`endpoint:${entryName}`)}: { id: ${JSON.stringify(
			entryName
		)}, handler: async () => ({ body: null }) } } }))();\n`
	);
}

export function endpointExtension(dir: string, name: string, confined: boolean): Extension {
	return {
		path: path.join(root, dir),
		name,
		type: 'endpoint',
		entrypoint: 'index.js',
		local: true,
		...(confined && { runtime: 'confined-server' as const }),
	};
}

export function hookExtension(dir: string, name: string, confined: boolean): Extension {
	return {
		path: path.join(root, dir),
		name,
		type: 'hook',
		entrypoint: 'index.js',
		local: true,
		...(confined && { runtime: 'confined-server' as const }),
	};
}

export function operationExtension(dir: string, name: string, confined: boolean): Extension {
	return {
		path: path.join(root, dir),
		name,
		type: 'operation',
		entrypoint: { app: 'app.js', api: 'api.js' },
		local: true,
		...(confined && { runtime: 'confined-server' as const }),
	};
}

export function bundleExtension(dir: string, name: string, confined: boolean): Extension {
	return {
		path: path.join(root, dir),
		name,
		type: 'bundle',
		entrypoint: { app: 'app.js', api: 'api.js' },
		entries: [{ type: 'endpoint', name: `${name}-endpoint` }],
		local: true,
		...(confined && { runtime: 'confined-server' as const }),
	};
}

export function manager(extensions: Extension[]): ExtensionManager {
	const instance = new ExtensionManager();
	(instance as any).extensions = extensions;
	(instance as any).serverExtensions = filterServerExtensions(extensions);
	(instance as any).diagnostics = [];
	return instance;
}

/**
 * Creates the temp dir and writes the baseline package fixtures the suites share, returning
 * the root. The caller stores the root and points the mocked `EXTENSIONS_PATH` at it.
 */
export function createExtensionFixtures(): string {
	root = mkdtempSync(path.join(tmpdir(), 'cairn-confined-'));

	writeConfinedPackage('confined-endpoint', 'export default {};\n', 'confined-endpoint', {
		endpoint: { access: 'public' },
	});

	writeConfinedPackage('flagged-endpoint', "import { readFile } from 'node:fs/promises';\nexport default {};\n");
	writeThrowingEntry('control-endpoint', 'index.js', 'CONTROL_ENDPOINT_IMPORTED');
	writeThrowingEntry('confined-hook', 'index.js', 'CONFINED_HOOK_IMPORTED');
	writeThrowingEntry('control-hook', 'index.js', 'CONTROL_HOOK_IMPORTED');
	writeThrowingEntry('confined-operation', 'api.js', 'CONFINED_OPERATION_IMPORTED');
	writeThrowingEntry('control-operation', 'api.js', 'CONTROL_OPERATION_IMPORTED');
	writeThrowingEntry('confined-bundle', 'api.js', 'CONFINED_BUNDLE_IMPORTED');
	writeThrowingEntry('control-bundle', 'api.js', 'CONTROL_BUNDLE_IMPORTED');

	return root;
}

export function cleanupExtensionFixtures(): void {
	rmSync(root, { recursive: true, force: true });
}
