import { assertType, describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

/**
 * Public export surface — both type-level and runtime assertions.
 *
 * Why both:
 * - Type-level (`@ts-expect-error`) catches TypeScript consumers who try to
 *   import a removed symbol — they get a compile error.
 * - Runtime (`expect(...).toBeUndefined()`) catches regressions where a
 *   removed symbol accidentally gets re-exported (e.g., a new barrel file
 *   forgets to exclude it). Plain-JS consumers and tree-shaken bundles
 *   silently get `undefined` without the runtime check.
 */

const UNSUPPORTED_EXPORTS = [
	// realtime: WebSocket client (no /websocket endpoint in CairnCMS)
	'realtime',
	// directus_translations: not a CRUD table (JSON-blob-on-settings)
	'readTranslations',
	'readTranslation',
	'createTranslation',
	'createTranslations',
	'updateTranslation',
	'updateTranslations',
	'deleteTranslation',
	'deleteTranslations',
	// directus_versions: content versioning not implemented
	'readContentVersions',
	'readContentVersion',
	'createContentVersion',
	'updateContentVersion',
	'deleteContentVersion',
	'deleteContentVersions',
	'saveToContentVersion',
	'promoteContentVersion',
	// directus_extensions: file-system-based, not a CRUD table
	'readExtensions',
	'updateExtension',
] as const;

describe('public export surface', () => {
	it('exports the supported composable API entry points', () => {
		// A single spot-check that the core composable factories exist with
		// callable signatures. If any of these are deleted accidentally, this
		// file fails to type-check.
		assertType<typeof sdk.createCairnCMS>(sdk.createCairnCMS);
		assertType<typeof sdk.rest>(sdk.rest);
		assertType<typeof sdk.graphql>(sdk.graphql);
		assertType<typeof sdk.authentication>(sdk.authentication);
		assertType<typeof sdk.staticToken>(sdk.staticToken);
	});

	it('does NOT export realtime at type-check time (removed in v1)', () => {
		// @ts-expect-error — `realtime` is intentionally absent in v1
		const _ = sdk.realtime;
	});

	it('does NOT export helpers for unsupported collections at type-check time', () => {
		// @ts-expect-error
		const _a = sdk.readTranslations;
		// @ts-expect-error
		const _b = sdk.createTranslation;
		// @ts-expect-error
		const _c = sdk.readContentVersions;
		// @ts-expect-error
		const _d = sdk.createContentVersion;
		// @ts-expect-error
		const _e = sdk.readExtensions;
		// @ts-expect-error
		const _f = sdk.updateExtension;
	});

	it('does NOT export unsupported symbols at runtime', () => {
		// Guards against silent regression where a removed symbol gets
		// re-exported (e.g., a new barrel file forgets to exclude it). Plain-JS
		// consumers skip the type check entirely, so this runtime assertion is
		// the only thing protecting them.
		for (const name of UNSUPPORTED_EXPORTS) {
			expect((sdk as any)[name], `${name} should not be exported`).toBeUndefined();
		}
	});
});
