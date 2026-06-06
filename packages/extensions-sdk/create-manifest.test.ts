import {
	BUNDLE_EXTENSION_TYPES,
	EXTENSION_PKG_KEY,
	EXTENSION_TYPES,
	HYBRID_EXTENSION_TYPES,
} from '@cairncms/constants';
import { isIn } from '@cairncms/utils';
import fse from 'fs-extra';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { create } from './src/cli/index.js';

vi.mock('execa', () => ({
	execa: vi.fn(async (file: string, args: string[] = []) =>
		file === 'npm' && args[0] === 'view'
			? { stdout: JSON.stringify({ 'dist-tags': { latest: '0.0.0' } }) }
			: { stdout: '', stderr: '' }
	),
}));

const testPrefix = 'temp-manifest';

afterAll(async () => {
	for (const artifact of (await fse.readdir(process.cwd())).filter((file) => file.startsWith(testPrefix))) {
		await fse.remove(artifact);
	}
});

const ALLOWED_OPTION_KEYS = new Set(['type', 'path', 'source', 'entries', 'host', 'hidden']);

describe('scaffold emits only the basic cairncms:extension manifest', () => {
	test.each([...EXTENSION_TYPES])('%s', async (type) => {
		const dir = `${testPrefix}-${type}-${Date.now()}`;

		await create(type, dir, { language: 'javascript' });

		const manifest = await fse.readJson(resolve(dir, 'package.json'));
		const options = manifest[EXTENSION_PKG_KEY];

		expect(options.type).toBe(type);
		expect(typeof options.host).toBe('string');

		if (isIn(type, BUNDLE_EXTENSION_TYPES)) {
			expect(options.path).toEqual({ app: expect.any(String), api: expect.any(String) });
			expect(Array.isArray(options.entries)).toBe(true);
			expect(options.source).toBeUndefined();
		} else if (isIn(type, HYBRID_EXTENSION_TYPES)) {
			expect(options.path).toEqual({ app: expect.any(String), api: expect.any(String) });
			expect(options.source).toEqual({ app: expect.any(String), api: expect.any(String) });
		} else {
			expect(typeof options.path).toBe('string');
			expect(typeof options.source).toBe('string');
		}

		const unexpectedKeys = Object.keys(options).filter((key) => !ALLOWED_OPTION_KEYS.has(key));
		expect(unexpectedKeys).toEqual([]);

		expect(manifest.name).toMatch(/^cairncms-extension-/);

		expect(fse.pathExistsSync(resolve(dir, 'cairncms.extension.json'))).toBe(false);
	});
});

const fromHere = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

describe('the SDK carries no contract, confined, or validate machinery', () => {
	test('the CLI registers only create, add, build, and link', () => {
		const runSource = readFileSync(fromHere('./src/cli/run.ts'), 'utf8');
		const commands = [...runSource.matchAll(/\.command\('([^']+)'\)/g)].map((match) => match[1]).sort();

		expect(commands).toEqual(['add', 'build', 'create', 'link']);
	});

	test('no contract-manifest, confined-build, or validate modules exist', () => {
		const forbidden = [
			'./src/cli/commands/validate.ts',
			'./src/cli/commands/helpers/contract-manifest.ts',
			'./src/cli/commands/helpers/build-confined-server-entry.ts',
			'./src/confined-build.ts',
		];

		for (const modulePath of forbidden) {
			expect(fse.pathExistsSync(fromHere(modulePath))).toBe(false);
		}
	});
});

describe('templates only import the public author surface', () => {
	const templatesDir = fromHere('./templates');

	const templateFiles = readdirSync(templatesDir, { recursive: true })
		.map(String)
		.filter((file) => /\.(ts|js|vue)$/.test(file));

	const FORBIDDEN_PREFIXES = [
		'@cairncms/utils',
		'@cairncms/types',
		'@cairncms/composables',
		'@cairncms/constants',
		'@directus/',
	];

	const ALLOWED_CAIRNCMS = [
		'@cairncms/extensions-sdk',
		'@cairncms/extensions-app-api',
		'@cairncms/extensions-server-api',
	];

	function importSpecifiers(source: string): string[] {
		return [...source.matchAll(/\b(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
	}

	function forbiddenSpecifiers(source: string): string[] {
		return importSpecifiers(source).filter((specifier) => {
			if (specifier.startsWith('.')) return false;
			if (FORBIDDEN_PREFIXES.some((prefix) => specifier.startsWith(prefix))) return true;
			return specifier.startsWith('@cairncms/') && !ALLOWED_CAIRNCMS.includes(specifier);
		});
	}

	test('there is at least one template file to scan', () => {
		expect(templateFiles.length).toBeGreaterThan(0);
	});

	test('flags from, side-effect, dynamic, and require imports of internals', () => {
		const snippet = [
			`import { A } from '@cairncms/types';`,
			`import '@cairncms/utils';`,
			`const c = await import('@cairncms/composables');`,
			`const d = require('@directus/api');`,
			`import ok from '@cairncms/extensions-sdk';`,
			`import vue from 'vue';`,
			`import rel from './local.js';`,
		].join('\n');

		expect(forbiddenSpecifiers(snippet).sort()).toEqual([
			'@cairncms/composables',
			'@cairncms/types',
			'@cairncms/utils',
			'@directus/api',
		]);
	});

	test.each(templateFiles)('%s', (relativeFile) => {
		expect(forbiddenSpecifiers(readFileSync(resolve(templatesDir, relativeFile), 'utf8'))).toEqual([]);
	});
});
