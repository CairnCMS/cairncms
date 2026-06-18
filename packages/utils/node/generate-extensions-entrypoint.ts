import { APP_EXTENSION_TYPES, HYBRID_EXTENSION_TYPES } from '@cairncms/constants';
import type { AppExtension, BundleExtension, Extension, HybridExtension } from '@cairncms/types';
import path from 'path';
import { isIn, isTypeIn } from './array-helpers.js';
import { pluralize } from './pluralize.js';
import { pathToRelativeUrl } from './path-to-relative-url.js';

const APP_OR_HYBRID_TYPES = [...APP_EXTENSION_TYPES, ...HYBRID_EXTENSION_TYPES];

// U+2028 and U+2029 terminate a string literal in older engines, and JSON.stringify leaves them raw.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

/**
 * Serialize a string as a JS string literal for the generated entrypoint, escaping the line
 * separators JSON.stringify leaves raw. Manifest names and entrypoint paths reach the generated
 * code from extension package.json, which the manifest schema validates only as a string, so every
 * embedded literal is emitted through here.
 */
function jsString(value: string): string {
	return JSON.stringify(value).replace(LINE_SEPARATORS, (char) => `\\u${char.charCodeAt(0).toString(16)}`);
}

// Emitted once when there is at least one extension to load. Each extension is
// imported dynamically inside loadExtension's try/catch and registered inside a
// per-extension try/catch, so one extension that throws while evaluating or
// registering (an incompatible build, a bad import, a malformed export) is
// logged and skipped instead of taking every other app extension down with it.
// pushConfig/pushEntries also validate the module shape, so a module that loads
// but exports the wrong thing is skipped, not registered.
const HELPERS =
	`async function loadExtension(name, importer) {` +
	`try { return await importer(); }` +
	`catch (error) { console.warn('Failed to load extension ' + name, error); return null; }` +
	`}` +
	`function pushConfig(name, collection, value) {` +
	`if (value && typeof value === 'object' && !Array.isArray(value)) collection.push(value);` +
	`else console.warn('Extension ' + name + ' has no valid default export');` +
	`}` +
	`function pushEntries(name, collection, values) {` +
	`if (Array.isArray(values)) collection.push(...values);` +
	`else if (values == null) console.warn('Extension ' + name + ' is missing a declared app entry export');` +
	`else console.warn('Extension ' + name + ' exported a non-array app entry');` +
	`}`;

export function generateExtensionsEntrypoint(extensions: Extension[]): string {
	const appOrHybridExtensions = extensions.filter((extension): extension is AppExtension | HybridExtension =>
		isIn(extension.type, APP_OR_HYBRID_TYPES)
	);

	const bundleExtensions = extensions.filter(
		(extension): extension is BundleExtension =>
			extension.type === 'bundle' && extension.entries.some((entry) => isIn(entry.type, APP_OR_HYBRID_TYPES))
	);

	const arrayNames = APP_OR_HYBRID_TYPES.map((type) => pluralize(type));
	const declarations = `const ${arrayNames.join(' = [], ')} = [];`;

	if (appOrHybridExtensions.length === 0 && bundleExtensions.length === 0) {
		return `${declarations}export { ${arrayNames.join(', ')} };`;
	}

	// A flat, deterministic order: standalones grouped by app/hybrid type, then
	// bundles. Each load is loaded in parallel; its index maps the resolved module
	// to the push that runs after Promise.all settles, so registration order stays
	// deterministic regardless of which import resolves first.
	const loads: { name: string; specifier: string; push: (ref: string) => string }[] = [];

	for (const type of APP_OR_HYBRID_TYPES) {
		for (const extension of appOrHybridExtensions.filter((extension) => extension.type === type)) {
			const entry = pathToRelativeUrl(
				path.resolve(
					extension.path,
					isTypeIn(extension, HYBRID_EXTENSION_TYPES) ? extension.entrypoint.app : extension.entrypoint
				)
			);

			loads.push({
				name: extension.name,
				specifier: `./${entry}`,
				push: (ref) => `pushConfig(${jsString(extension.name)}, ${pluralize(type)}, ${ref}.default);`,
			});
		}
	}

	for (const extension of bundleExtensions) {
		const entry = pathToRelativeUrl(path.resolve(extension.path, extension.entrypoint.app));

		const appTypes = APP_OR_HYBRID_TYPES.filter((type) => extension.entries.some((entry) => entry.type === type));

		loads.push({
			name: extension.name,
			specifier: `./${entry}`,
			push: (ref) =>
				appTypes
					.map((type) => `pushEntries(${jsString(extension.name)}, ${pluralize(type)}, ${ref}.${pluralize(type)});`)
					.join(''),
		});
	}

	const promiseAll = `Promise.all([${loads
		.map((load) => `loadExtension(${jsString(load.name)}, () => import(${jsString(load.specifier)}))`)
		.join(',')}])`;

	const thenBody = loads
		.map(
			(load, i) =>
				`if (mods[${i}]) { try { ${load.push(`mods[${i}]`)} } catch (error) { ` +
				`console.warn('Failed to register extension ' + ${jsString(load.name)}, error); } }`
		)
		.join('');

	const ready = `const ready = ${promiseAll}.then((mods) => {${thenBody}});`;

	return `${declarations}${HELPERS}${ready}export { ${arrayNames.join(', ')}, ready };`;
}
