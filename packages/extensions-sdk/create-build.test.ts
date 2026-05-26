import { EXTENSION_LANGUAGES, EXTENSION_PKG_KEY, JAVASCRIPT_FILE_EXTS } from '@cairncms/constants';
import { execa } from 'execa';
import fse from 'fs-extra';
import { resolve } from 'node:path';
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
