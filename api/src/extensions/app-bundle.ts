import { APP_SHARED_DEPS } from '@cairncms/constants';
import type { Extension } from '@cairncms/types';
import { generateExtensionsEntrypoint, resolvePackage } from '@cairncms/utils/node';
import aliasDefault from '@rollup/plugin-alias';
import nodeResolveDefault from '@rollup/plugin-node-resolve';
import virtualDefault from '@rollup/plugin-virtual';
import { escapeRegExp } from 'lodash-es';
import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'path';
import { rollup, type OutputChunk } from 'rollup';
import env from '../env.js';
import logger from '../logger.js';
import { sanitizeExtensionError, type SanitizedExtensionError } from '../utils/sanitize-extension-error.js';
import { Url } from '../utils/url.js';

// Rollup plugins ship with CJS-style `default` exports but are typed as the module itself;
// these casts unwrap to the real functions.
const virtual = virtualDefault as unknown as typeof virtualDefault.default;
const alias = aliasDefault as unknown as typeof aliasDefault.default;
const nodeResolve = nodeResolveDefault as unknown as typeof nodeResolveDefault.default;

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppExtensionBundle {
	code: string | null;
	chunks: Map<string, string>;
	failure: SanitizedExtensionError | null;
}

// Matches an app shared-dependency entry chunk by name, e.g. "vue" ->
// "vue.ev7YwI6S.entry.js". The hash is Vite's URL-safe [hash], base64url with
// mixed case plus - and _, not lowercase hex, so the charset must allow
// [A-Za-z0-9_-] or no shared dep ever resolves and the app bundler re-bundles them.
export function findSharedDepAsset(dep: string, assetFiles: string[]): string | undefined {
	const depRegex = new RegExp(`^${escapeRegExp(dep.replace(/\//g, '_'))}\\.[A-Za-z0-9_-]+\\.entry\\.js$`);
	return assetFiles.find((file) => depRegex.test(file));
}

/**
 * Bundles the app extensions into the entry chunk the admin app loads. `chunks` and
 * `failure` are not exclusive: a build that emits chunks but no entry chunk fails with the
 * chunks intact. The caller owns all state and applies both.
 */
export async function buildAppExtensionBundle(extensions: Extension[]): Promise<AppExtensionBundle> {
	const chunks = new Map<string, string>();

	const sharedDepsMapping = await getSharedDepsMapping(APP_SHARED_DEPS);

	const internalImports = Object.entries(sharedDepsMapping).map(([name, path]) => ({
		find: name,
		replacement: path,
	}));

	const entrypoint = generateExtensionsEntrypoint(extensions);

	try {
		const bundle = await rollup({
			input: 'entry',
			external: Object.values(sharedDepsMapping),
			makeAbsoluteExternalsRelative: false,
			plugins: [virtual({ entry: entrypoint }), alias({ entries: internalImports }), nodeResolve({ browser: true })],
		});

		const { output } = await bundle.generate({ format: 'es', compact: true });

		for (const out of output) {
			if (out.type === 'chunk') {
				chunks.set(out.fileName, out.code);
			}
		}

		await bundle.close();

		// Dynamic imports in the entrypoint make rollup emit multiple chunks, so the
		// entry is not reliably output[0]. Select it explicitly, and treat a missing
		// entry as a build failure (through the catch) rather than returning null,
		// which would 404 /extensions/sources/index.js with no diagnostic.
		const entryChunk = output.find((out): out is OutputChunk => out.type === 'chunk' && out.isEntry);

		if (!entryChunk) {
			throw new Error('app extension bundle produced no entry chunk');
		}

		return { code: entryChunk.code, chunks, failure: null };
	} catch (error: any) {
		return { code: null, chunks, failure: sanitizeExtensionError(error, 'BUNDLE_BUILD_FAILED') };
	}
}

async function getSharedDepsMapping(deps: string[]): Promise<Record<string, string>> {
	const appDir = await readdir(path.join(resolvePackage('@cairncms/app', __dirname), 'dist', 'assets'));

	const depsMapping: Record<string, string> = {};

	for (const dep of deps) {
		const depName = findSharedDepAsset(dep, appDir);

		if (depName) {
			const depUrl = new Url(env['PUBLIC_URL']).addPath('admin', 'assets', depName);

			depsMapping[dep] = depUrl.toString({ rootRelative: true });
		} else {
			logger.warn(`Couldn't find shared extension dependency "${dep}"`);
		}
	}

	return depsMapping;
}
