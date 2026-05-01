import chalk from 'chalk';
import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ora from 'ora';
import * as pkg from '../../../utils/package.js';
import checkDocker from '../../utils/check-docker.js';
import createProjectFiles from '../../utils/create-project-files/index.js';
import generateSecrets, { type GeneratedSecrets } from '../../utils/generate-secrets.js';
import resolveProjectPath, { type ResolvedProjectPath } from '../../utils/resolve-project-path.js';
import writeDockerEnv from '../../utils/write-docker-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_TEMPLATE_PATH = path.resolve(__dirname, '../../templates/docker-compose.yaml');
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 2_000;

interface InitOptions {
	start?: boolean;
}

export default async function init(projectName: string | undefined, options: InitOptions = {}): Promise<void> {
	const start = options.start !== false;

	await checkDocker();

	const target = await resolveProjectPath(projectName);
	process.chdir(target.absolutePath);

	const cairncmsImageTag = resolveCairncmsVersion();
	const secrets = await generateSecrets();

	await copyComposeTemplate(target.absolutePath);
	await writeDockerEnv({ secrets, cairncmsImageTag, targetDir: target.absolutePath });
	await createProjectFiles(target.absolutePath);

	let healthy = false;

	if (start) {
		try {
			await startStack(target.absolutePath);
		} catch (err) {
			printStartFailureGuidance(target);
			throw err;
		}

		healthy = await waitForHealthy(target.absolutePath);
	}

	printSuccess({ target, secrets, started: start, healthy });

	process.exit(0);
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

async function copyComposeTemplate(targetDir: string): Promise<void> {
	const dest = path.join(targetDir, 'docker-compose.yml');
	const content = await fs.readFile(COMPOSE_TEMPLATE_PATH, 'utf8');
	await fs.writeFile(dest, content);
}

function printStartFailureGuidance(target: ResolvedProjectPath): void {
	process.stdout.write(
		`\n${chalk.yellow(
			'Note:'
		)} If postgres started before this failure, retrying with the same name will hit a credentials mismatch (the volume keeps the original password; a re-init generates a new one).\n`
	);

	process.stdout.write(`To reset cleanly:\n`);
	process.stdout.write(`  ${chalk.blue('cd')} ${target.name}\n`);
	process.stdout.write(`  ${chalk.blue('docker compose down -v')}\n`);
	process.stdout.write(`Then remove ${chalk.green(target.absolutePath)} before re-running init.\n\n`);
}

async function startStack(cwd: string): Promise<void> {
	const spinner = ora('Pulling images and starting containers...').start();

	try {
		await execa('docker', ['compose', '--project-directory', cwd, 'up', '-d'], { cwd });
		spinner.succeed('Containers started');
	} catch (err) {
		spinner.fail('Failed to start containers');
		throw err;
	}
}

async function waitForHealthy(cwd: string): Promise<boolean> {
	const spinner = ora('Waiting for CairnCMS to report healthy...').start();
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;

	while (Date.now() < deadline) {
		if (await isCairncmsHealthy(cwd)) {
			spinner.succeed('CairnCMS is healthy');
			return true;
		}

		await sleep(HEALTH_POLL_INTERVAL_MS);
	}

	spinner.warn(
		'CairnCMS did not report healthy within timeout. Containers are running; first boot may still be in progress.'
	);

	return false;
}

async function isCairncmsHealthy(cwd: string): Promise<boolean> {
	try {
		const result = await execa('docker', ['compose', '--project-directory', cwd, 'ps', '--format', 'json'], { cwd });
		const services = parseComposePs(result.stdout);
		const cairncms = services.find((entry) => entry.Service === 'cairncms');
		return cairncms?.Health === 'healthy';
	} catch {
		return false;
	}
}

interface ComposeService {
	Service?: string;
	Health?: string;
}

function parseComposePs(stdout: string): ComposeService[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];

	if (trimmed.startsWith('[')) {
		try {
			return JSON.parse(trimmed) as ComposeService[];
		} catch {
			return [];
		}
	}

	return trimmed
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as ComposeService;
			} catch {
				return null;
			}
		})
		.filter((entry): entry is ComposeService => entry !== null);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

interface PrintSuccessParams {
	target: ResolvedProjectPath;
	secrets: GeneratedSecrets;
	started: boolean;
	healthy: boolean;
}

function printSuccess({ target, secrets, started, healthy }: PrintSuccessParams): void {
	process.stdout.write(`\n${chalk.green('CairnCMS project created at')} ${target.absolutePath}\n`);

	if (!started) {
		process.stdout.write(`\nTo start your stack:\n`);
		process.stdout.write(`  ${chalk.blue('cd')} ${target.name}\n`);
		process.stdout.write(`  ${chalk.blue('docker compose up -d')}\n`);
	} else if (healthy) {
		process.stdout.write(`\nYour CairnCMS instance is running at ${chalk.blue('http://localhost:8055')}\n`);
	} else {
		process.stdout.write(
			`\nContainers are starting. Once CairnCMS is ready, open ${chalk.blue('http://localhost:8055')}\n`
		);

		process.stdout.write(`Check status: ${chalk.blue('docker compose ps')}\n`);
		process.stdout.write(`Tail logs:    ${chalk.blue('docker compose logs cairncms')}\n`);
	}

	process.stdout.write(`\nAdmin login:\n`);
	process.stdout.write(`  Email:    ${chalk.blue('admin@example.com')}\n`);
	process.stdout.write(`  Password: ${chalk.blue(secrets.ADMIN_PASSWORD)}\n`);

	process.stdout.write(
		`\nDB credentials and other configuration are in ${chalk.green(path.join(target.absolutePath, '.env'))}\n`
	);

	process.stdout.write(`\nTo stop the stack:\n`);
	process.stdout.write(`  ${chalk.blue('cd')} ${target.name}\n`);
	process.stdout.write(`  ${chalk.blue('docker compose down')}\n`);
}
