import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Extension } from '@cairncms/types';
import { generateExtensionsEntrypoint } from './generate-extensions-entrypoint.js';

const DECL = `const interfaces = [], displays = [], layouts = [], modules = [], panels = [], operations = [];`;

const HELPERS =
	`async function loadExtension(name, importer) {try { return await importer(); }catch (error) { console.warn('Failed to load extension ' + name, error); return null; }}` +
	`function pushConfig(name, collection, value) {if (value && typeof value === 'object' && !Array.isArray(value)) collection.push(value);else console.warn('Extension ' + name + ' has no valid default export');}` +
	`function pushEntries(name, collection, values) {if (Array.isArray(values)) collection.push(...values);else if (values == null) console.warn('Extension ' + name + ' is missing a declared app entry export');else console.warn('Extension ' + name + ' exported a non-array app entry');}`;

const EXPORTS = `export { interfaces, displays, layouts, modules, panels, operations`;

const reg = (index: number, name: string, push: string) =>
	`if (mods[${index}]) { try { ${push} } catch (error) { console.warn('Failed to register extension ' + ${JSON.stringify(
		name
	)}, error); } }`;

describe('generateExtensionsEntrypoint', () => {
	it('returns an empty extension entrypoint if there is no App, Hybrid or Bundle extension', () => {
		const mockExtensions: Extension[] = [
			{
				path: './extensions/bundle',
				name: 'mock-bundle0-extension',
				version: '1.0.0',
				type: 'bundle',
				entrypoint: { app: 'app.js', api: 'api.js' },
				entries: [],
				host: '^10.0.0',
				local: false,
			},
		];

		expect(generateExtensionsEntrypoint(mockExtensions)).toBe(`${DECL}${EXPORTS} };`);
	});

	it('returns an extension entrypoint exporting a single App extension', () => {
		const mockExtensions: Extension[] = [
			{ path: './extensions/panel', name: 'mock-panel-extension', type: 'panel', entrypoint: 'index.js', local: true },
		];

		expect(generateExtensionsEntrypoint(mockExtensions)).toBe(
			`${DECL}${HELPERS}const ready = Promise.all([loadExtension("mock-panel-extension", () => import("./extensions/panel/index.js"))]).then((mods) => {${reg(
				0,
				'mock-panel-extension',
				`pushConfig("mock-panel-extension", panels, mods[0].default);`
			)}});${EXPORTS}, ready };`
		);
	});

	it('returns an extension entrypoint exporting a single Hybrid extension', () => {
		const mockExtensions: Extension[] = [
			{
				path: './extensions/operation',
				name: 'mock-operation-extension',
				type: 'operation',
				entrypoint: { app: 'app.js', api: 'api.js' },
				local: true,
			},
		];

		expect(generateExtensionsEntrypoint(mockExtensions)).toBe(
			`${DECL}${HELPERS}const ready = Promise.all([loadExtension("mock-operation-extension", () => import("./extensions/operation/app.js"))]).then((mods) => {${reg(
				0,
				'mock-operation-extension',
				`pushConfig("mock-operation-extension", operations, mods[0].default);`
			)}});${EXPORTS}, ready };`
		);
	});

	it('returns an extension entrypoint exporting from a single Bundle extension', () => {
		const mockExtensions: Extension[] = [
			{
				path: './extensions/bundle',
				name: 'mock-bundle-extension',
				version: '1.0.0',
				type: 'bundle',
				entrypoint: { app: 'app.js', api: 'api.js' },
				entries: [
					{ type: 'interface', name: 'mock-bundle-interface' },
					{ type: 'operation', name: 'mock-bundle-operation' },
					{ type: 'hook', name: 'mock-bundle-hook' },
				],
				host: '^10.0.0',
				local: false,
			},
		];

		expect(generateExtensionsEntrypoint(mockExtensions)).toBe(
			`${DECL}${HELPERS}const ready = Promise.all([loadExtension("mock-bundle-extension", () => import("./extensions/bundle/app.js"))]).then((mods) => {${reg(
				0,
				'mock-bundle-extension',
				`pushEntries("mock-bundle-extension", interfaces, mods[0].interfaces);pushEntries("mock-bundle-extension", operations, mods[0].operations);`
			)}});${EXPORTS}, ready };`
		);
	});

	it("still emits a confined bundle's app entries through the app pipeline", () => {
		const mockExtensions: Extension[] = [
			{
				path: './extensions/bundle',
				name: 'mock-confined-bundle-extension',
				version: '1.0.0',
				type: 'bundle',
				entrypoint: { app: 'app.js', api: 'api.js' },
				entries: [
					{ type: 'interface', name: 'mock-bundle-interface' },
					{ type: 'endpoint', name: 'mock-bundle-endpoint' },
				],
				host: '^10.0.0',
				local: false,
				runtime: 'confined-server',
			},
		];

		expect(generateExtensionsEntrypoint(mockExtensions)).toBe(
			`${DECL}${HELPERS}const ready = Promise.all([loadExtension("mock-confined-bundle-extension", () => import("./extensions/bundle/app.js"))]).then((mods) => {${reg(
				0,
				'mock-confined-bundle-extension',
				`pushEntries("mock-confined-bundle-extension", interfaces, mods[0].interfaces);`
			)}});${EXPORTS}, ready };`
		);
	});

	it('returns an extension entrypoint exporting multiple extensions', () => {
		const mockExtensions: Extension[] = [
			{
				path: './extensions/display',
				name: 'mock-display-extension',
				type: 'display',
				entrypoint: 'index.js',
				local: true,
			},
			{
				path: './extensions/operation',
				name: 'mock-operation-extension',
				type: 'operation',
				entrypoint: { app: 'app.js', api: 'api.js' },
				local: true,
			},
			{
				path: './extensions/bundle',
				name: 'mock-bundle0-extension',
				version: '1.0.0',
				type: 'bundle',
				entrypoint: { app: 'app.js', api: 'api.js' },
				entries: [
					{ type: 'layout', name: 'mock-bundle-layout' },
					{ type: 'operation', name: 'mock-bundle-operation' },
					{ type: 'hook', name: 'mock-bundle-hook' },
				],
				host: '^10.0.0',
				local: false,
			},
			{
				path: './extensions/bundle-no-app',
				name: 'mock-bundle-no-app-extension',
				version: '1.0.0',
				type: 'bundle',
				entrypoint: { app: 'app.js', api: 'api.js' },
				entries: [{ type: 'endpoint', name: 'mock-bundle-no-app-endpoint' }],
				host: '^10.0.0',
				local: false,
			},
		];

		expect(generateExtensionsEntrypoint(mockExtensions)).toBe(
			`${DECL}${HELPERS}const ready = Promise.all([loadExtension("mock-display-extension", () => import("./extensions/display/index.js")),loadExtension("mock-operation-extension", () => import("./extensions/operation/app.js")),loadExtension("mock-bundle0-extension", () => import("./extensions/bundle/app.js"))]).then((mods) => {${reg(
				0,
				'mock-display-extension',
				`pushConfig("mock-display-extension", displays, mods[0].default);`
			)}${reg(
				1,
				'mock-operation-extension',
				`pushConfig("mock-operation-extension", operations, mods[1].default);`
			)}${reg(
				2,
				'mock-bundle0-extension',
				`pushEntries("mock-bundle0-extension", layouts, mods[2].layouts);pushEntries("mock-bundle0-extension", operations, mods[2].operations);`
			)}});${EXPORTS}, ready };`
		);
	});

	// The bug was runtime module-evaluation behavior, not string shape. These execute
	// the generated module against real fixtures under CWD (the generated specifiers are
	// CWD-relative, and the entry is written at CWD, so the dynamic imports resolve).
	describe('runtime isolation', () => {
		let dir: string;
		let entry: string;

		beforeEach(() => {
			dir = path.resolve(process.cwd(), '__loader_behavior__');
			entry = path.resolve(process.cwd(), '__loader_entry__.mjs');
			mkdirSync(dir, { recursive: true });
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
			rmSync(entry, { force: true });
		});

		async function evaluate(extensions: Extension[]) {
			writeFileSync(entry, generateExtensionsEntrypoint(extensions));
			return import(`${pathToFileURL(entry).href}?t=${performance.now()}`);
		}

		it('skips an extension that throws on evaluation and keeps the others', async () => {
			writeFileSync(path.join(dir, 'good.mjs'), 'export default { id: "good" };');
			writeFileSync(path.join(dir, 'bad.mjs'), 'throw new Error("boom at eval");');

			const extensions: Extension[] = [
				{ path: dir, name: 'good-display', type: 'display', entrypoint: 'good.mjs', local: true },
				{ path: dir, name: 'bad-display', type: 'display', entrypoint: 'bad.mjs', local: true },
			];

			const mod = await evaluate(extensions);
			await mod.ready;

			expect(mod.displays).toEqual([{ id: 'good' }]);
		});

		it('skips a module with no default export and a bundle with a non-array app export', async () => {
			writeFileSync(path.join(dir, 'good.mjs'), 'export default { id: "good" };');
			writeFileSync(path.join(dir, 'nodefault.mjs'), 'export const x = 1;');
			writeFileSync(path.join(dir, 'badbundle.mjs'), 'export const panels = "not-an-array";');

			const extensions: Extension[] = [
				{ path: dir, name: 'good-display', type: 'display', entrypoint: 'good.mjs', local: true },
				{ path: dir, name: 'nodefault-display', type: 'display', entrypoint: 'nodefault.mjs', local: true },
				{
					path: dir,
					name: 'bad-bundle',
					version: '1.0.0',
					type: 'bundle',
					entrypoint: { app: 'badbundle.mjs', api: 'api.js' },
					entries: [{ type: 'panel', name: 'p' }],
					host: '^10.0.0',
					local: false,
				},
			];

			const mod = await evaluate(extensions);
			await mod.ready;

			expect(mod.displays).toEqual([{ id: 'good' }]);
			expect(mod.panels).toEqual([]);
		});

		it('skips a standalone whose default export is an array, not a config object', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

			writeFileSync(path.join(dir, 'arraydefault.mjs'), 'export default [{ id: "not-a-config" }];');
			writeFileSync(path.join(dir, 'good.mjs'), 'export default { id: "good" };');

			const extensions: Extension[] = [
				{ path: dir, name: 'array-display', type: 'display', entrypoint: 'arraydefault.mjs', local: true },
				{ path: dir, name: 'good-display', type: 'display', entrypoint: 'good.mjs', local: true },
			];

			const mod = await evaluate(extensions);
			await mod.ready;

			expect(mod.displays).toEqual([{ id: 'good' }]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no valid default export'));

			warn.mockRestore();
		});

		it('contains a push-time throw and keeps later siblings', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

			writeFileSync(
				path.join(dir, 'throwbundle.mjs'),
				'const panels = [{ id: "p1" }];Object.defineProperty(panels, Symbol.iterator, { value: () => { throw new Error("boom during spread"); } });export { panels };'
			);

			writeFileSync(path.join(dir, 'goodbundle.mjs'), 'export const panels = [{ id: "p2" }];');

			const extensions: Extension[] = [
				{
					path: dir,
					name: 'throw-bundle',
					version: '1.0.0',
					type: 'bundle',
					entrypoint: { app: 'throwbundle.mjs', api: 'api.js' },
					entries: [{ type: 'panel', name: 'p1' }],
					host: '^10.0.0',
					local: false,
				},
				{
					path: dir,
					name: 'good-bundle',
					version: '1.0.0',
					type: 'bundle',
					entrypoint: { app: 'goodbundle.mjs', api: 'api.js' },
					entries: [{ type: 'panel', name: 'p2' }],
					host: '^10.0.0',
					local: false,
				},
			];

			const mod = await evaluate(extensions);
			await mod.ready;

			expect(mod.panels).toEqual([{ id: 'p2' }]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to register extension '), expect.anything());

			warn.mockRestore();
		});

		it('warns when a bundle is missing a declared app entry export', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

			writeFileSync(path.join(dir, 'noexport.mjs'), 'export const interfaces = [{ id: "i1" }];');

			const extensions: Extension[] = [
				{
					path: dir,
					name: 'drift-bundle',
					version: '1.0.0',
					type: 'bundle',
					entrypoint: { app: 'noexport.mjs', api: 'api.js' },
					entries: [
						{ type: 'interface', name: 'i1' },
						{ type: 'panel', name: 'p1' },
					],
					host: '^10.0.0',
					local: false,
				},
			];

			const mod = await evaluate(extensions);
			await mod.ready;

			expect(mod.interfaces).toEqual([{ id: 'i1' }]);
			expect(mod.panels).toEqual([]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('is missing a declared app entry export'));

			warn.mockRestore();
		});

		it('escapes line separators in names and specifiers so the generated literal stays valid', async () => {
			const u2028 = String.fromCharCode(0x2028);
			const u2029 = String.fromCharCode(0x2029);

			writeFileSync(path.join(dir, 'good.mjs'), 'export default { id: "good" };');

			const extensions: Extension[] = [
				{ path: dir, name: `evil${u2028}${u2029}"\nname`, type: 'display', entrypoint: 'good.mjs', local: true },
				{ path: dir, name: 'pathy', type: 'display', entrypoint: `nope${u2028}.mjs`, local: true },
			];

			const source = generateExtensionsEntrypoint(extensions);

			// A raw separator would terminate the string literal, so neither reaches the source.
			expect(source).not.toContain(u2028);
			expect(source).not.toContain(u2029);
			// They are emitted as escapes instead, from both the name and the import specifier.
			expect(source).toContain('\\u2028');
			expect(source).toContain('\\u2029');

			// The generated module still parses and the valid extension loads (the bad-path one is skipped).
			const mod = await evaluate(extensions);
			await mod.ready;
			expect(mod.displays).toEqual([{ id: 'good' }]);
		});
	});
});
