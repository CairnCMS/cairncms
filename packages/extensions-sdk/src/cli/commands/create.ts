import {
	BUNDLE_EXTENSION_TYPES,
	EXTENSION_LANGUAGES,
	EXTENSION_NAME_REGEX,
	EXTENSION_PKG_KEY,
	EXTENSION_TYPES,
	HYBRID_EXTENSION_TYPES,
} from '@cairncms/constants';
import type {
	ApiExtensionType,
	AppExtensionType,
	BundleExtensionType,
	ExtensionOptions,
	ExtensionType,
	HybridExtensionType,
} from '@cairncms/types';
import { isIn } from '@cairncms/utils';
import chalk from 'chalk';
import { execa } from 'execa';
import fse from 'fs-extra';
import ora from 'ora';
import path from 'path';
import getPackageManager from '../utils/get-package-manager.js';
import getSdkVersion from '../utils/get-sdk-version.js';
import { isLanguage, languageToShort } from '../utils/languages.js';
import { log } from '../utils/logger.js';
import copyTemplate, { type TemplateName } from './helpers/copy-template.js';
import ensureTypecheckScript from './helpers/ensure-typecheck-script.js';
import getExtensionDevDeps from './helpers/get-extension-dev-deps.js';

type CreateOptions = { language?: string; confined?: boolean };

export default async function create(type: string, name: string, options: CreateOptions): Promise<void> {
	const targetDir = name.substring(name.lastIndexOf('/') + 1);
	const targetPath = path.resolve(targetDir);

	if (!isIn(type, EXTENSION_TYPES)) {
		log(
			`Extension type ${chalk.bold(type)} is not supported. Available extension types: ${EXTENSION_TYPES.map((t) =>
				chalk.bold.magenta(t)
			).join(', ')}.`,
			'error'
		);

		process.exit(1);
	}

	if (options.confined && type !== 'operation' && type !== 'endpoint' && type !== 'hook') {
		log(
			`The confined runtime supports ${chalk.bold('operation')}, ${chalk.bold('endpoint')}, and ${chalk.bold(
				'hook'
			)} extensions only. Type ${chalk.bold(type)} cannot be scaffolded confined yet.`,
			'error'
		);

		process.exitCode = 1;
		return;
	}

	if (targetDir.length === 0) {
		log(`Extension name can not be empty.`, 'error');
		process.exit(1);
	}

	if (await fse.pathExists(targetPath)) {
		const info = await fse.stat(targetPath);

		if (!info.isDirectory()) {
			log(`Destination ${chalk.bold(targetDir)} already exists and is not a directory.`, 'error');
			process.exit(1);
		}

		const files = await fse.readdir(targetPath);

		if (files.length > 0) {
			log(`Destination ${chalk.bold(targetDir)} already exists and is not empty.`, 'error');
			process.exit(1);
		}
	}

	if (isIn(type, BUNDLE_EXTENSION_TYPES)) {
		await createPackageExtension({ type, name, targetDir, targetPath });
	} else {
		const language = options.language ?? 'javascript';

		await createLocalExtension({ type, name, targetDir, targetPath, language, confined: options.confined ?? false });
	}
}

async function createPackageExtension({
	type,
	name,
	targetDir,
	targetPath,
}: {
	type: BundleExtensionType;
	name: string;
	targetDir: string;
	targetPath: string;
}) {
	const spinner = ora(chalk.bold('Scaffolding CairnCMS extension...')).start();

	await fse.ensureDir(targetPath);
	await copyTemplate(type, targetPath);

	const host = `^${getSdkVersion()}`;
	const options = { type, path: { app: 'dist/app.js', api: 'dist/api.js' }, entries: [], host };
	const packageManifest = getPackageManifest(name, options, getExtensionDevDeps(type));

	await fse.writeJSON(path.join(targetPath, 'package.json'), packageManifest, { spaces: '\t' });

	const packageManager = getPackageManager();

	await execa(packageManager, ['install'], { cwd: targetPath });

	spinner.succeed(chalk.bold('Done'));

	log(getDoneMessage(type, targetDir, targetPath, packageManager));
}

async function createLocalExtension({
	type,
	name,
	targetDir,
	targetPath,
	language,
	confined,
}: {
	type: AppExtensionType | ApiExtensionType | HybridExtensionType;
	name: string;
	targetDir: string;
	targetPath: string;
	language: string;
	confined: boolean;
}) {
	if (!isLanguage(language)) {
		log(
			`Language ${chalk.bold(language)} is not supported. Available languages: ${EXTENSION_LANGUAGES.map((t) =>
				chalk.bold.magenta(t)
			).join(', ')}.`,
			'error'
		);

		process.exit(1);
	}

	const spinner = ora(chalk.bold('Scaffolding CairnCMS extension...')).start();

	await fse.ensureDir(targetPath);

	let template: TemplateName = type;

	if (confined && type === 'endpoint') template = 'endpoint-confined';
	else if (confined && type === 'hook') template = 'hook-confined';
	else if (confined) template = 'operation-confined';

	await copyTemplate(template, targetPath, 'src', language);

	const host = `^${getSdkVersion()}`;

	let options: ExtensionOptions;

	if (confined && type === 'endpoint') {
		options = {
			type: 'endpoint',
			path: 'dist/index.js',
			source: `src/index.${languageToShort(language)}`,
			runtime: 'confined-server',
			// Authenticated by default: serving anonymous callers is a deliberate opt-in.
			capabilities: { log: true, endpoint: { access: 'authenticated' } },
			host,
		};
	} else if (confined && type === 'hook') {
		options = {
			type: 'hook',
			path: 'dist/index.js',
			source: `src/index.${languageToShort(language)}`,
			runtime: 'confined-server',
			capabilities: { log: true },
			// Must equal the template's declared handlers: the load probe enforces it.
			events: { action: ['items.create'] },
			host,
		};
	} else if (confined) {
		options = {
			type: 'operation',
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			source: { app: `src/app.${languageToShort(language)}`, api: `src/api.${languageToShort(language)}` },
			runtime: 'confined-server',
			capabilities: { log: true },
			host,
		};
	} else if (isIn(type, HYBRID_EXTENSION_TYPES)) {
		options = {
			type,
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			source: { app: `src/app.${languageToShort(language)}`, api: `src/api.${languageToShort(language)}` },
			host,
		};
	} else {
		options = {
			type,
			path: 'dist/index.js',
			source: `src/index.${languageToShort(language)}`,
			host,
		};
	}

	const devDeps = confined
		? { ...getExtensionDevDeps(type, language), '@cairncms/extensions-server-api': getSdkVersion() }
		: getExtensionDevDeps(type, language);

	const packageManifest = getPackageManifest(name, options, devDeps);

	await fse.writeJSON(path.join(targetPath, 'package.json'), packageManifest, { spaces: '\t' });

	if (confined) {
		// The engine's identity contract requires the entry id to equal the
		// extension name, so the scaffold writes the final name into the source.
		await applyExtensionName(targetPath, packageManifest['name']);
	}

	const packageManager = getPackageManager();

	await execa(packageManager, ['install'], { cwd: targetPath });

	spinner.succeed(chalk.bold('Done'));

	log(getDoneMessage(type, targetDir, targetPath, packageManager));
}

async function applyExtensionName(targetPath: string, packageName: string): Promise<void> {
	const sourceDir = path.join(targetPath, 'src');

	for (const file of await fse.readdir(sourceDir)) {
		const filePath = path.join(sourceDir, file);
		const content = await fse.readFile(filePath, 'utf8');

		if (content.includes('__extension_name__')) {
			await fse.writeFile(filePath, content.replaceAll('__extension_name__', packageName));
		}
	}
}

function getPackageManifest(name: string, options: ExtensionOptions, deps: Record<string, string>) {
	const packageManifest: Record<string, any> = {
		name: EXTENSION_NAME_REGEX.test(name) ? name : `cairncms-extension-${name}`,
		description: 'Please enter a description for your extension',
		icon: 'extension',
		version: '1.0.0',
		keywords: ['cairncms', 'cairncms-extension', `cairncms-custom-${options.type}`],
		type: 'module',
		[EXTENSION_PKG_KEY]: options,
		scripts: {
			build: 'cairncms-extension build',
			dev: 'cairncms-extension build -w --no-minify',
			link: 'cairncms-extension link',
		},
		devDependencies: deps,
	};

	if (options.type === 'bundle') {
		packageManifest['scripts']['add'] = 'cairncms-extension add';
	}

	ensureTypecheckScript(packageManifest);

	return packageManifest;
}

function getDoneMessage(type: ExtensionType, targetDir: string, targetPath: string, packageManager: string) {
	return `
Your ${type} extension has been created at ${chalk.green(targetPath)}

To start developing, run:
	${chalk.blue('cd')} ${targetDir}
	${chalk.blue(`${packageManager} run`)} dev

and then to build for production, run:
	${chalk.blue(`${packageManager} run`)} build
`;
}
