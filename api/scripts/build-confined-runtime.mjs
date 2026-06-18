/**
 * Bundles the confined child host so its supported startup and invocation path requires no
 * node_modules, letting the supervisor grant the spawned child read access to this runtime
 * dir alone (the hardened read scope then blocks the deps' unused optional imports). The
 * WASM is copied beside the bundle because the emscripten glue loads it via
 * `new URL("emscripten-module.wasm", import.meta.url)`. The createRequire banner works
 * around a transitive builtin dynamic require (`cluster`) that esbuild's ESM `require` shim
 * otherwise rejects.
 */

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The esbuild options for the bundle, shared with the bundle-sanity test. */
export function confinedRuntimeEsbuildOptions(apiRoot = API_ROOT) {
	return {
		entryPoints: [join(apiRoot, 'src/extensions/confined/child-host.ts')],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
	};
}

/** Builds the bundle into `dist/extensions/confined/runtime` and copies the WASM sibling. */
export async function buildConfinedRuntime(apiRoot = API_ROOT) {
	const require = createRequire(import.meta.url);
	const outDir = join(apiRoot, 'dist/extensions/confined/runtime');
	const wasm = require.resolve('@jitl/quickjs-ng-wasmfile-release-asyncify/wasm');

	// Clear the dir first so a stale file from a previous build cannot survive into the
	// runtime read scope.
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	await build({ ...confinedRuntimeEsbuildOptions(apiRoot), outfile: join(outDir, 'child-host.mjs') });
	copyFileSync(wasm, join(outDir, 'emscripten-module.wasm'));

	return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const outDir = await buildConfinedRuntime();
	process.stdout.write(`confined runtime bundled -> ${outDir}\n`);
}
