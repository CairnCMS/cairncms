import chalk from 'chalk';
import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ora from 'ora';
import * as pkg from '../../../utils/package.js';
import checkDocker from '../../utils/check-docker.js';
import checkPorts from '../../utils/check-ports.js';
import createApplianceFiles from '../../utils/create-appliance-files.js';
import createProjectFiles from '../../utils/create-project-files/index.js';
import generateSecrets, { type GeneratedSecrets } from '../../utils/generate-secrets.js';
import resolveProjectPath, { type ResolvedProjectPath } from '../../utils/resolve-project-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTRO_ASCII_PATH = path.resolve(__dirname, '../../templates/intro-ascii.txt');
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 2_000;
const DEFAULT_PORT = 8055;
const BANNER_COLOR = '#c8552e';

interface InitOptions {
	start?: boolean;
}

export default async function init(projectName: string | undefined, options: InitOptions = {}): Promise<void> {
	const start = options.start !== false;
	const cairncmsPort = DEFAULT_PORT;

	await printIntro();

	await checkDocker();

	const target = await resolveProjectPath(projectName);
	process.chdir(target.absolutePath);

	const cairncmsVersion = resolveCairncmsVersion();
	const secrets = await generateSecrets();

	await createProjectFiles({
		absolutePath: target.absolutePath,
		projectName: target.name,
		cairncmsPort,
	});

	await createApplianceFiles({
		appliancePath: target.appliancePath,
		projectName: target.name,
		cairncmsVersion,
		cairncmsPort,
		secrets,
	});

	process.stdout.write('\n');

	let healthy = false;

	if (start) {
		await checkPorts({ port: cairncmsPort });

		try {
			await startStack(target);
		} catch (err) {
			printStartFailureGuidance(target);
			throw err;
		}

		healthy = await waitForHealthy(cairncmsPort);
	}

	printSuccess({ target, secrets, started: start, healthy, cairncmsPort });

	process.exit(0);
}

async function printIntro(): Promise<void> {
	try {
		const banner = await fs.readFile(INTRO_ASCII_PATH, 'utf8');
		process.stdout.write('\n');
		process.stdout.write(chalk.hex(BANNER_COLOR)(banner));
		process.stdout.write(chalk.dim(`  v${pkg.version}\n\n`));
	} catch {
		/* skip */
	}
}

function resolveCairncmsVersion(): string {
	const envVersion = process.env['CAIRNCMS_PACKAGE_VERSION'];

	if (envVersion) {
		return envVersion;
	}

	process.stdout.write(
		`${chalk.yellow('Warning:')} CAIRNCMS_PACKAGE_VERSION is not set. Using @cairncms/api version (${
			pkg.version
		}) as fallback.\n`
	);

	return pkg.version;
}

function printStartFailureGuidance(target: ResolvedProjectPath): void {
	process.stdout.write(`\n${chalk.yellow('⚠ Warning: docker compose up did not complete cleanly.')}\n\n`);
	process.stdout.write(`To reset cleanly:\n`);
	process.stdout.write(`  ${chalk.cyan('cd')} ${target.name}\n`);
	process.stdout.write(`  ${chalk.cyan('docker compose --project-directory cairncms down -v')}\n\n`);
	process.stdout.write(`Then remove ${chalk.green(target.absolutePath)} before re-running init.\n\n`);
}

async function startStack(target: ResolvedProjectPath): Promise<void> {
	const spinner = ora('Pulling images and starting containers...').start();

	try {
		await execa(
			'docker',
			['compose', '--project-directory', target.appliancePath, '-f', composeFile(target), 'up', '-d'],
			{ cwd: target.absolutePath, extendEnv: false, env: dockerComposeEnv() }
		);

		spinner.succeed('Stack started.');
	} catch (err) {
		spinner.fail('Failed to start containers');
		throw err;
	}
}

function dockerComposeEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };

	for (const key of [
		'KEY',
		'SECRET',
		'DB_USER',
		'DB_PASSWORD',
		'DB_DATABASE',
		'ADMIN_EMAIL',
		'ADMIN_PASSWORD',
		'CAIRNCMS_PORT',
		'CACHE_ENABLED',
		'CACHE_AUTO_PURGE',
		'CACHE_STORE',
		'CACHE_REDIS',
		'WEBSOCKETS_ENABLED',
		'PUBLIC_URL',
		'CORS_ENABLED',
		'CORS_ORIGIN',
		'REFRESH_TOKEN_COOKIE_SECURE',
		'REFRESH_TOKEN_COOKIE_SAME_SITE',
		'REFRESH_TOKEN_COOKIE_DOMAIN',
		'SESSION_COOKIE_SECURE',
		'SESSION_COOKIE_SAME_SITE',
		'SESSION_COOKIE_DOMAIN',
		'EXTENSIONS_PATH',
		'EXTENSIONS_AUTO_RELOAD',
		'EMAIL_TRANSPORT',
		'EMAIL_FROM',
		'EMAIL_SMTP_HOST',
		'EMAIL_SMTP_PORT',
		'EMAIL_SMTP_USER',
		'EMAIL_SMTP_PASSWORD',
	]) {
		delete env[key];
	}

	return env;
}

async function waitForHealthy(cairncmsPort: number): Promise<boolean> {
	const spinner = ora('Waiting for CairnCMS to report healthy...').start();
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	const url = `http://localhost:${cairncmsPort}/server/health`;

	while (Date.now() < deadline) {
		if (await isCairncmsHealthy(url)) {
			spinner.succeed('CairnCMS is healthy.');
			return true;
		}

		await sleep(HEALTH_POLL_INTERVAL_MS);
	}

	spinner.warn(
		'CairnCMS did not report healthy within timeout. Containers are running; first boot may still be in progress.'
	);

	return false;
}

async function isCairncmsHealthy(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
		return response.ok;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function composeFile(target: ResolvedProjectPath): string {
	return path.join(target.appliancePath, 'docker-compose.yml');
}

interface PrintSuccessParams {
	target: ResolvedProjectPath;
	secrets: GeneratedSecrets;
	started: boolean;
	healthy: boolean;
	cairncmsPort: number;
}

function printSuccess({ target, secrets, started, healthy, cairncmsPort }: PrintSuccessParams): void {
	process.stdout.write(`\n${chalk.green('CairnCMS project created at')} ${target.absolutePath}\n`);

	if (started && healthy) {
		process.stdout.write(`\nYour CairnCMS instance is running at ${chalk.green(`http://localhost:${cairncmsPort}`)}\n`);
	} else if (started) {
		process.stdout.write(
			`\nContainers are starting. Once CairnCMS is ready, open ${chalk.green(`http://localhost:${cairncmsPort}`)}\n`
		);
	} else {
		process.stdout.write(`\nYour stack is configured but not running. To start it:\n`);
		process.stdout.write(`  ${chalk.cyan('cd')} ${target.name}\n`);
		process.stdout.write(`  ${chalk.cyan('npm start')}\n`);
	}

	process.stdout.write(`\n${chalk.bold('Admin login:')}\n`);
	process.stdout.write(`  Email:    admin@example.com\n`);
	process.stdout.write(`  Password: ${chalk.yellow(secrets.ADMIN_PASSWORD)}\n`);
	process.stdout.write(chalk.dim(`  (stored in cairncms/.env)\n`));

	process.stdout.write(`\nCairnCMS is free for personal and commercial use under GPLv3.\n`);
}
