import { execa } from 'execa';
import fse from 'fs-extra';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import ensureTypecheckScript from './src/cli/commands/helpers/ensure-typecheck-script.js';
import getExtensionDevDeps from './src/cli/commands/helpers/get-extension-dev-deps.js';
import getPinnedVersion from './src/cli/utils/get-pinned-version.js';

const sdkRoot = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tscPath = require.resolve('typescript/lib/tsc.js');
const vueDir = dirname(require.resolve('vue/package.json'));
const typesNodeDir = dirname(require.resolve('@types/node/package.json'));

const testPrefix = 'temp-ts-types';

afterAll(async () => {
	const artifacts = (await fse.readdir(sdkRoot)).filter((file) => file.startsWith(testPrefix));
	for (const artifact of artifacts) await fse.remove(resolve(sdkRoot, artifact));
});

async function withPinnedFixture<T>(
	setup: (dir: string) => Promise<void>,
	run: (dir: string) => Promise<T>
): Promise<T> {
	const dir = resolve(sdkRoot, `${testPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

	try {
		await fse.ensureDir(resolve(dir, 'node_modules', '@cairncms'));
		await fse.ensureDir(resolve(dir, 'node_modules', '@types'));
		await fse.symlink(sdkRoot, resolve(dir, 'node_modules', '@cairncms', 'extensions-sdk'));
		await fse.symlink(vueDir, resolve(dir, 'node_modules', 'vue'));
		await fse.symlink(typesNodeDir, resolve(dir, 'node_modules', '@types', 'node'));
		await setup(dir);
		return await run(dir);
	} finally {
		await fse.remove(dir);
	}
}

async function typecheck(dir: string): Promise<{ exitCode: number | undefined; output: string }> {
	const result = await execa('node', [tscPath, '--noEmit'], { cwd: dir, reject: false });
	return { exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}` };
}

test('the SDK advertises its type declarations', async () => {
	const pkg = await fse.readJson(resolve(sdkRoot, 'package.json'));

	expect(pkg.types).toBe('dist/index.d.ts');
	expect(pkg.exports['.']).toMatchObject({ types: './dist/index.d.ts', default: './dist/index.js' });
});

test('TypeScript scaffold devDeps are exact, SDK-pinned versions', () => {
	const deps = getExtensionDevDeps('operation', 'typescript');

	expect(deps['typescript']).toBe(getPinnedVersion('typescript'));
	expect(deps['vue']).toBe(getPinnedVersion('vue'));
	expect(deps['@types/node']).toBe(getPinnedVersion('@types/node'));

	for (const name of ['typescript', 'vue', '@types/node']) {
		expect(deps[name]).not.toMatch(/^[\^~]/);
	}
});

test('ensureTypecheckScript adds the typecheck script only when needed and never clobbers a custom one', () => {
	const tsManifest: Record<string, any> = {
		scripts: { build: 'cairncms-extension build' },
		devDependencies: { typescript: '5.0.4' },
	};

	ensureTypecheckScript(tsManifest);
	expect(tsManifest['scripts'].typecheck).toBe('tsc --noEmit');
	expect(tsManifest['scripts'].build).toBe('cairncms-extension build');

	const jsManifest: Record<string, any> = { scripts: { build: 'cairncms-extension build' }, devDependencies: {} };
	ensureTypecheckScript(jsManifest);
	expect(jsManifest['scripts'].typecheck).toBeUndefined();

	const customManifest: Record<string, any> = {
		scripts: { typecheck: 'tsc --noEmit --strict' },
		devDependencies: { typescript: '5.0.4' },
	};

	ensureTypecheckScript(customManifest);
	expect(customManifest['scripts'].typecheck).toBe('tsc --noEmit --strict');
});

test('the scaffold tsconfig uses bundler resolution, not the deprecated node10', async () => {
	const tsconfig = await fse.readJson(resolve(sdkRoot, 'templates', 'common', 'typescript', 'config', 'tsconfig.json'));

	expect(tsconfig.compilerOptions.module).toBe('ESNext');
	expect(tsconfig.compilerOptions.moduleResolution).toBe('bundler');
	expect(tsconfig.compilerOptions.moduleResolution).not.toBe('node');
});

test.each(['interface', 'display', 'layout', 'module', 'panel', 'hook', 'endpoint', 'operation'])(
	'TypeScript %s scaffold type-checks against the pinned local SDK',
	async (type) => {
		const result = await withPinnedFixture(async (dir) => {
			await fse.copy(resolve(sdkRoot, 'templates', type, 'typescript', 'source'), resolve(dir, 'src'));

			await fse.copy(
				resolve(sdkRoot, 'templates', 'common', 'typescript', 'config', 'tsconfig.json'),
				resolve(dir, 'tsconfig.json')
			);
		}, typecheck);

		expect(result.output).not.toMatch(/error TS/);
		expect(result.exitCode).toBe(0);
	},
	30_000
);

test.each(['node16', 'bundler'])(
	'SDK types resolve under moduleResolution %s',
	async (moduleResolution) => {
		const result = await withPinnedFixture(async (dir) => {
			await fse.outputFile(
				resolve(dir, 'src', 'index.ts'),
				"import { defineInterface } from '@cairncms/extensions-sdk';\nexport const probe = defineInterface;\n"
			);

			await fse.outputJson(resolve(dir, 'tsconfig.json'), {
				compilerOptions: {
					module: moduleResolution === 'node16' ? 'node16' : 'ESNext',
					moduleResolution,
					noEmit: true,
					skipLibCheck: true,
					strict: true,
				},
				include: ['src/**/*.ts'],
			});
		}, typecheck);

		expect(result.output).not.toMatch(
			/Cannot find module '@cairncms|Could not find a declaration file for module '@cairncms/
		);

		expect(result.exitCode).toBe(0);
	},
	30_000
);

test('the SDK runtime entry resolves through the export map', async () => {
	const result = await withPinnedFixture(
		async (dir) => {
			await fse.outputFile(
				resolve(dir, 'check.mjs'),
				"import * as sdk from '@cairncms/extensions-sdk';\nif (typeof sdk.defineInterface !== 'function') process.exit(3);\n"
			);
		},
		(dir) => execa('node', ['check.mjs'], { cwd: dir, reject: false })
	);

	expect(result.exitCode).toBe(0);
});
