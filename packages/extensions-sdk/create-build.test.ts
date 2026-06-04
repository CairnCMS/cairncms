import { EXTENSION_LANGUAGES, EXTENSION_PKG_KEY, JAVASCRIPT_FILE_EXTS } from '@cairncms/constants';
import { execa } from 'execa';
import fse from 'fs-extra';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { create } from './src/cli/index.js';
import { languageToShort } from './src/cli/utils/languages.js';

const testPrefix = `temp-extension`;

afterAll(async () => {
	// Remove all temp test artifacts
	const testArtifacts = (await fse.readdir(process.cwd())).filter((file) => file.startsWith(testPrefix));

	for (const tempArtifact of testArtifacts) {
		await fse.remove(tempArtifact);
	}
});

function getConfigFileContent(configFileName: string) {
	switch (configFileName) {
		case 'extension.config.js':
		case 'extension.config.mjs':
			return `export default { plugins: [] };`;
		case 'extension.config.cjs':
			return `module.exports = { plugins: [] };`;
		default:
			return '';
	}
}

// Test one extension from each of app/api/hybrid extensions, and each config file names
test.each(
	['interface', 'endpoint', 'operation'].map((extensionType, index) => {
		return { extensionType, configFileName: `extension.config.${JAVASCRIPT_FILE_EXTS[index]}` };
	})
)(
	`create and build new $extensionType extension with $configFileName config file`,
	async ({ extensionType, configFileName }) => {
		const currentTime = Date.now();

		for (const language of EXTENSION_LANGUAGES) {
			const testExtensionPath = `${testPrefix}-${extensionType}-${language}-${currentTime}`;

			// Create
			await create(extensionType, testExtensionPath, { language });

			if (extensionType === 'operation') {
				expect(fse.pathExistsSync(resolve(testExtensionPath, 'src', `api.${languageToShort(language)}`))).toBe(true);
				expect(fse.pathExistsSync(resolve(testExtensionPath, 'src', `app.${languageToShort(language)}`))).toBe(true);
			} else {
				expect(fse.pathExistsSync(resolve(testExtensionPath, 'src', `index.${languageToShort(language)}`))).toBe(true);
			}

			// Add dummy config file to verify they are loaded properly when building the extension
			await fse.outputFile(resolve(testExtensionPath, configFileName), getConfigFileContent(configFileName));
			expect(fse.pathExistsSync(resolve(testExtensionPath, configFileName))).toBe(true);

			// Build
			await execa('node', ['../cli.js', 'build'], { cwd: testExtensionPath });

			if (extensionType === 'operation') {
				expect(fse.pathExistsSync(resolve(testExtensionPath, 'dist', 'api.js'))).toBe(true);
				expect(fse.pathExistsSync(resolve(testExtensionPath, 'dist', 'app.js'))).toBe(true);
			} else {
				expect(fse.pathExistsSync(resolve(testExtensionPath, 'dist', 'index.js'))).toBe(true);
			}
		}
	},
	// Bump up timeout duration as the build process can take slightly longer to complete
	30_000
);

type Format = 'esm' | 'cjs';

type ContentCase = {
	label: string;
	setupManifest?: (manifest: Record<string, any>) => void;
	buildArgs: string[];
	builtFile: string;
	expectFormat: Format;
};

function assertFormat(content: string, format: Format) {
	// `\bexport\b` matches the ESM keyword but rejects the CJS identifier `exports`.
	const esmExport = /\bexport\b/;
	const cjsExports = /\bmodule\.exports\b/;

	if (format === 'esm') {
		expect(content).toMatch(esmExport);
		expect(content).not.toMatch(cjsExports);
	} else {
		expect(content).toMatch(cjsExports);
		expect(content).not.toMatch(esmExport);
	}
}

test.each<ContentCase>([
	{
		label: 'scaffolded endpoint emits ESM via the default "type": "module"',
		buildArgs: ['build'],
		builtFile: 'dist/index.js',
		expectFormat: 'esm',
	},
	{
		label: 'endpoint without "type" emits CJS',
		setupManifest: (manifest) => {
			delete manifest['type'];
		},
		buildArgs: ['build'],
		builtFile: 'dist/index.js',
		expectFormat: 'cjs',
	},
	{
		label: '.mjs output extension forces ESM even when manifest has no "type"',
		setupManifest: (manifest) => {
			delete manifest['type'];
			manifest[EXTENSION_PKG_KEY].path = 'dist/index.mjs';
		},
		buildArgs: ['build'],
		builtFile: 'dist/index.mjs',
		expectFormat: 'esm',
	},
	{
		label: '.cjs output extension forces CJS even when manifest has "type": "module"',
		setupManifest: (manifest) => {
			manifest[EXTENSION_PKG_KEY].path = 'dist/index.cjs';
		},
		buildArgs: ['build'],
		builtFile: 'dist/index.cjs',
		expectFormat: 'cjs',
	},
	{
		label: 'explicit-CLI without manifest "type" emits CJS',
		setupManifest: (manifest) => {
			delete manifest['type'];
		},
		buildArgs: ['build', '-t', 'endpoint', '-i', 'src/index.js', '-o', 'dist/explicit.js'],
		builtFile: 'dist/explicit.js',
		expectFormat: 'cjs',
	},
	{
		label: 'explicit-CLI with manifest "type": "module" emits ESM',
		buildArgs: ['build', '-t', 'endpoint', '-i', 'src/index.js', '-o', 'dist/explicit.js'],
		builtFile: 'dist/explicit.js',
		expectFormat: 'esm',
	},
])(
	'$label',
	async ({ setupManifest, buildArgs, builtFile, expectFormat }) => {
		const currentTime = Date.now();

		const testExtensionPath = `${testPrefix}-content-${expectFormat}-${currentTime}-${Math.random()
			.toString(36)
			.slice(2, 8)}`;

		await create('endpoint', testExtensionPath, { language: 'javascript' });

		if (setupManifest) {
			const manifestPath = resolve(testExtensionPath, 'package.json');
			const manifest = await fse.readJson(manifestPath);
			setupManifest(manifest);
			await fse.writeJson(manifestPath, manifest, { spaces: '\t' });
		}

		await execa('node', ['../cli.js', ...buildArgs], { cwd: testExtensionPath });

		const builtFileParts = builtFile.split('/');
		const content = await fse.readFile(resolve(testExtensionPath, ...builtFileParts), 'utf-8');

		assertFormat(content, expectFormat);
	},
	30_000
);

function uniquePath(label: string) {
	return `${testPrefix}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const bareDepImport = /from\s*['"]fixture-runtime-dep['"]/;
const subpathDepImport = /from\s*['"]fixture-runtime-dep\/sub['"]/;

async function addLocalRuntimeDep(extPath: string, depName: string, { subpath = false, optional = false } = {}) {
	const depDir = resolve(extPath, 'node_modules', depName);
	await fse.outputJson(resolve(depDir, 'package.json'), { name: depName, version: '1.0.0', main: 'index.js' });
	await fse.outputFile(resolve(depDir, 'index.js'), `module.exports = { marker: 'DEP_MAIN_MARKER' };\n`);

	if (subpath) {
		await fse.outputFile(resolve(depDir, 'sub.js'), `module.exports = { marker: 'DEP_SUB_MARKER' };\n`);
	}

	const field = optional ? 'optionalDependencies' : 'dependencies';
	const manifestPath = resolve(extPath, 'package.json');
	const manifest = await fse.readJson(manifestPath);
	manifest[field] = { ...(manifest[field] ?? {}), [depName]: '1.0.0' };
	await fse.writeJson(manifestPath, manifest, { spaces: '\t' });
}

async function addLocalSdk(extPath: string) {
	const dir = resolve(extPath, 'node_modules', '@cairncms', 'extensions-sdk');

	await fse.outputJson(resolve(dir, 'package.json'), {
		name: '@cairncms/extensions-sdk',
		version: '1.0.0',
		type: 'module',
		main: 'index.js',
	});

	await fse.outputFile(
		resolve(dir, 'index.js'),
		[`export const defineEndpoint = (config) => config;`, `export const defineHook = (config) => config;`, ``].join(
			'\n'
		)
	);
}

test('node endpoint build externalizes declared runtime deps and subpaths, bundles relative source and the SDK', async () => {
	const ext = uniquePath('ext-node');
	await create('endpoint', ext, { language: 'javascript' });
	await addLocalRuntimeDep(ext, 'fixture-runtime-dep', { subpath: true });
	await addLocalSdk(ext);

	await fse.outputFile(resolve(ext, 'src', 'helper.js'), `export const RELATIVE_HELPER = 'RELATIVE_HELPER_MARKER';\n`);

	await fse.outputFile(
		resolve(ext, 'src', 'index.js'),
		[
			`import { defineEndpoint } from '@cairncms/extensions-sdk';`,
			`import depMain from 'fixture-runtime-dep';`,
			`import depSub from 'fixture-runtime-dep/sub';`,
			`import { RELATIVE_HELPER } from './helper.js';`,
			`export default defineEndpoint((router) => {`,
			`	router.get('/', (_req, res) => res.json({ depMain, depSub, RELATIVE_HELPER }));`,
			`});`,
			``,
		].join('\n')
	);

	await execa('node', ['../cli.js', 'build', '--no-minify'], { cwd: ext });
	const out = await fse.readFile(resolve(ext, 'dist', 'index.js'), 'utf-8');

	expect(out).toMatch(bareDepImport);
	expect(out).toMatch(subpathDepImport);
	expect(out).toContain('RELATIVE_HELPER_MARKER');
	expect(out).not.toContain('@cairncms/extensions-sdk');
}, 30_000);

test('browser interface build bundles declared runtime deps instead of externalizing them', async () => {
	const ext = uniquePath('ext-browser');
	await create('interface', ext, { language: 'javascript' });
	await addLocalRuntimeDep(ext, 'fixture-runtime-dep');

	await fse.outputFile(
		resolve(ext, 'src', 'index.js'),
		[
			`import dep from 'fixture-runtime-dep';`,
			`export default {`,
			`	id: 'fixture-iface', name: 'Fixture', icon: 'box',`,
			`	component: { render: () => dep.marker }, types: ['string'],`,
			`};`,
			``,
		].join('\n')
	);

	await execa('node', ['../cli.js', 'build', '--no-minify'], { cwd: ext });
	const out = await fse.readFile(resolve(ext, 'dist', 'index.js'), 'utf-8');

	expect(out).toContain('DEP_MAIN_MARKER');
	expect(out).not.toMatch(bareDepImport);
}, 30_000);

test('operation build externalizes runtime deps on the api side but bundles them on the app side', async () => {
	const ext = uniquePath('ext-op');
	await create('operation', ext, { language: 'javascript' });
	await addLocalRuntimeDep(ext, 'fixture-runtime-dep');

	await fse.outputFile(
		resolve(ext, 'src', 'api.js'),
		[
			`import dep from 'fixture-runtime-dep';`,
			`export default { id: 'fixture-op', handler: () => dep.marker };`,
			``,
		].join('\n')
	);

	await fse.outputFile(
		resolve(ext, 'src', 'app.js'),
		[
			`import dep from 'fixture-runtime-dep';`,
			`export default { id: 'fixture-op', name: 'Fixture', icon: 'box', overview: () => [], options: [], marker: dep.marker };`,
			``,
		].join('\n')
	);

	await execa('node', ['../cli.js', 'build', '--no-minify'], { cwd: ext });
	const apiOut = await fse.readFile(resolve(ext, 'dist', 'api.js'), 'utf-8');
	const appOut = await fse.readFile(resolve(ext, 'dist', 'app.js'), 'utf-8');

	expect(apiOut).toMatch(bareDepImport);
	expect(appOut).toContain('DEP_MAIN_MARKER');
	expect(appOut).not.toMatch(bareDepImport);
}, 30_000);

test('bundle build externalizes runtime deps on the api side', async () => {
	const ext = uniquePath('ext-bundle');
	await create('endpoint', ext, { language: 'javascript' });
	await addLocalRuntimeDep(ext, 'fixture-runtime-dep');

	await fse.outputFile(
		resolve(ext, 'src', 'entry.js'),
		[
			`import dep from 'fixture-runtime-dep';`,
			`export default (router) => router.get('/', (_req, res) => res.json({ m: dep.marker }));`,
			``,
		].join('\n')
	);

	const entries = JSON.stringify([{ type: 'endpoint', name: 'bundled-endpoint', source: 'src/entry.js' }]);
	const output = JSON.stringify({ app: 'dist/app.js', api: 'dist/api.js' });

	await execa('node', ['../cli.js', 'build', '-t', 'bundle', '-i', entries, '-o', output, '--no-minify'], { cwd: ext });
	const apiOut = await fse.readFile(resolve(ext, 'dist', 'api.js'), 'utf-8');

	expect(apiOut).toMatch(bareDepImport);
}, 30_000);

test('an externalized runtime dep resolves from the extension package node_modules at load', async () => {
	const ext = uniquePath('ext-runtime');
	await create('endpoint', ext, { language: 'javascript' });
	await addLocalRuntimeDep(ext, 'fixture-runtime-dep');

	await fse.outputFile(
		resolve(ext, 'src', 'index.js'),
		[
			`import dep from 'fixture-runtime-dep';`,
			`export const depMarker = dep.marker;`,
			`export default (router) => router.get('/', (_req, res) => res.json({ m: dep.marker }));`,
			``,
		].join('\n')
	);

	await execa('node', ['../cli.js', 'build', '--no-minify'], { cwd: ext });
	const builtUrl = pathToFileURL(resolve(ext, 'dist', 'index.js')).href;
	const mod = await import(builtUrl);

	expect(mod.depMarker).toBe('DEP_MAIN_MARKER');
	expect(typeof mod.default).toBe('function');
}, 30_000);

test('node build externalizes optionalDependencies the same as dependencies', async () => {
	const ext = uniquePath('ext-optional');
	await create('endpoint', ext, { language: 'javascript' });
	await addLocalRuntimeDep(ext, 'fixture-runtime-dep', { optional: true });

	await fse.outputFile(
		resolve(ext, 'src', 'index.js'),
		[
			`import dep from 'fixture-runtime-dep';`,
			`export default (router) => router.get('/', (_req, res) => res.json({ m: dep.marker }));`,
			``,
		].join('\n')
	);

	await execa('node', ['../cli.js', 'build', '--no-minify'], { cwd: ext });
	const out = await fse.readFile(resolve(ext, 'dist', 'index.js'), 'utf-8');

	expect(out).toMatch(bareDepImport);
}, 30_000);

test('node build leaves Node builtin imports external', async () => {
	const ext = uniquePath('ext-builtin');
	await create('endpoint', ext, { language: 'javascript' });

	await fse.outputFile(
		resolve(ext, 'src', 'index.js'),
		[
			`import os from 'node:os';`,
			`import path from 'path';`,
			`export default (router) => router.get('/', (_req, res) => res.json({ p: path.basename(String(os.hostname())) }));`,
			``,
		].join('\n')
	);

	await execa('node', ['../cli.js', 'build', '--no-minify'], { cwd: ext });
	const out = await fse.readFile(resolve(ext, 'dist', 'index.js'), 'utf-8');

	expect(out).toMatch(/from\s*['"]node:os['"]/);
	expect(out).toMatch(/from\s*['"]path['"]/);
}, 30_000);
