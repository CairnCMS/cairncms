import { ExtensionManifest } from '@cairncms/constants';
import { execa } from 'execa';
import fse from 'fs-extra';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { create } from './src/cli/index.js';
import getPackageManager from './src/cli/utils/get-package-manager.js';
import { languageToShort } from './src/cli/utils/languages.js';

// Disjoint from every other test file's cleanup prefix, because the suites run
// in parallel and each afterAll sweeps its own prefix.
const testPrefix = 'temp-scaffold-confined';

const sdkRoot = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const serverApiRoot = dirname(require.resolve('@cairncms/extensions-server-api/package.json'));

/**
 * In this monorepo the author package resolves through a workspace-member
 * symlink straight to sibling source, which the build's containment rule
 * refuses by design (the linked-local-dependency shape). A real install lays
 * the package out as real files in a store directory reached through a
 * node_modules symlink, so the test materializes that registry shape inside
 * the scaffolded package.
 */
async function stageRegistryStyleDependency(dir: string): Promise<void> {
	const store = resolve(
		dir,
		'node_modules',
		'.pnpm',
		'cairncms-extensions-server-api@1.1.0',
		'node_modules',
		'@cairncms',
		'extensions-server-api'
	);

	await fse.ensureDir(store);
	await fse.copy(resolve(serverApiRoot, 'package.json'), resolve(store, 'package.json'), { dereference: true });
	await fse.copy(resolve(serverApiRoot, 'dist'), resolve(store, 'dist'), { dereference: true });

	const link = resolve(dir, 'node_modules', '@cairncms', 'extensions-server-api');
	await fse.remove(link);
	await fse.ensureSymlink(store, link, 'dir');
}

afterAll(async () => {
	const testArtifacts = (await fse.readdir(process.cwd())).filter((file) => file.startsWith(testPrefix));

	for (const tempArtifact of testArtifacts) {
		await fse.remove(tempArtifact);
	}
});

function evalGlobal(code: string, globalName = 'CairnOperation'): { default: { id: string; handler: unknown } } {
	return new Function(`${code}\nreturn ${globalName};`)();
}

test.each(['javascript', 'typescript'])(
	'scaffolds, builds, and type-checks a confined operation (%s)',
	async (language) => {
		const dir = `${testPrefix}-${language}-${Date.now()}`;
		const short = languageToShort(language as 'javascript' | 'typescript');

		await create('operation', dir, { language, confined: true });

		const manifest = await fse.readJSON(resolve(dir, 'package.json'));
		const options = manifest['cairncms:extension'];

		expect(options.runtime).toBe('confined-server');
		expect(options.capabilities).toEqual({ log: true });
		expect(options.source).toEqual({ app: `src/app.${short}`, api: `src/api.${short}` });
		expect(options.path).toEqual({ app: 'dist/app.js', api: 'dist/api.js' });
		expect(manifest.devDependencies['@cairncms/extensions-server-api']).toBeDefined();
		expect(() => ExtensionManifest.parse(manifest)).not.toThrow();

		for (const file of [`api.${short}`, `app.${short}`]) {
			const source = await fse.readFile(resolve(dir, 'src', file), 'utf8');
			expect(source, file).toContain(`'${manifest.name}'`);
			expect(source, file).not.toContain('__extension_name__');
		}

		if (language === 'typescript') {
			await stageRegistryStyleDependency(dir);

			// The workspace skips self-linking the SDK into a package nested inside
			// it, so the SDK types are staged the way typescript-types.test.ts does.
			await fse.ensureSymlink(sdkRoot, resolve(dir, 'node_modules', '@cairncms', 'extensions-sdk'), 'dir');
		}

		await execa('node', ['../cli.js', 'build'], { cwd: dir });

		const artifact = await fse.readFile(resolve(dir, 'dist', 'api.js'), 'utf8');
		expect(artifact).toContain('var CairnOperation');
		expect(evalGlobal(artifact).default.id).toBe(manifest.name);
		expect(await fse.pathExists(resolve(dir, 'dist', 'app.js'))).toBe(true);

		if (language === 'typescript') {
			await execa(getPackageManager(), ['run', 'typecheck'], { cwd: dir });
		}
	},
	120_000
);

test.each(['javascript', 'typescript'])(
	'scaffolds, builds, and type-checks a confined endpoint (%s)',
	async (language) => {
		const dir = `${testPrefix}-endpoint-${language}-${Date.now()}`;
		const short = languageToShort(language as 'javascript' | 'typescript');

		await create('endpoint', dir, { language, confined: true });

		const manifest = await fse.readJSON(resolve(dir, 'package.json'));
		const options = manifest['cairncms:extension'];

		expect(options.runtime).toBe('confined-server');
		expect(options.capabilities).toEqual({ log: true, endpoint: { access: 'authenticated' } });
		expect(options.source).toBe(`src/index.${short}`);
		expect(options.path).toBe('dist/index.js');
		expect(manifest.devDependencies['@cairncms/extensions-server-api']).toBeDefined();
		expect(() => ExtensionManifest.parse(manifest)).not.toThrow();

		const source = await fse.readFile(resolve(dir, 'src', `index.${short}`), 'utf8');
		expect(source).toContain(`'${manifest.name}'`);
		expect(source).not.toContain('__extension_name__');

		if (language === 'typescript') {
			await stageRegistryStyleDependency(dir);

			// The workspace skips self-linking the SDK into a package nested inside
			// it, so the SDK types are staged the way typescript-types.test.ts does.
			await fse.ensureSymlink(sdkRoot, resolve(dir, 'node_modules', '@cairncms', 'extensions-sdk'), 'dir');
		}

		await execa('node', ['../cli.js', 'build'], { cwd: dir });

		const artifact = await fse.readFile(resolve(dir, 'dist', 'index.js'), 'utf8');
		expect(artifact).toContain('var CairnEndpoint');
		expect(evalGlobal(artifact, 'CairnEndpoint').default.id).toBe(manifest.name);

		if (language === 'typescript') {
			await execa(getPackageManager(), ['run', 'typecheck'], { cwd: dir });
		}
	},
	120_000
);

test('refuses a confined scaffold for a type without a runtime contract', async () => {
	const result = await execa('node', ['cli.js', 'create', 'hook', `${testPrefix}-refuse-${Date.now()}`, '--confined'], {
		reject: false,
	});

	expect(result.exitCode).toBe(1);
	expect(`${result.stdout}${result.stderr}`).toContain('hook');
}, 30_000);
