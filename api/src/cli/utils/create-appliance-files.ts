import chalk from 'chalk';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeneratedSecrets } from './generate-secrets.js';
import writeDockerEnv from './write-docker-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_TEMPLATE_PATH = path.resolve(__dirname, '../templates/docker-compose.yaml');

export interface CreateApplianceFilesParams {
	appliancePath: string;
	projectName: string;
	cairncmsVersion: string;
	cairncmsPort: number;
	secrets: GeneratedSecrets;
}

export default async function createApplianceFiles({
	appliancePath,
	projectName,
	cairncmsVersion,
	cairncmsPort,
	secrets,
}: CreateApplianceFilesParams): Promise<void> {
	await fs.mkdir(appliancePath, { recursive: true });

	await renderCompose({ appliancePath, projectName, cairncmsVersion });
	logCreated(path.join(appliancePath, 'docker-compose.yml'));

	const { envPath, envExamplePath } = await writeDockerEnv({ secrets, targetDir: appliancePath, cairncmsPort });
	logCreated(envPath);
	logCreated(envExamplePath);

	for (const dir of ['snapshots', 'config', 'extensions', 'uploads']) {
		await ensureDirWithGitkeep(path.join(appliancePath, dir));
	}
}

async function renderCompose({
	appliancePath,
	projectName,
	cairncmsVersion,
}: {
	appliancePath: string;
	projectName: string;
	cairncmsVersion: string;
}): Promise<void> {
	const template = await fs.readFile(COMPOSE_TEMPLATE_PATH, 'utf8');

	const rendered = template
		.replaceAll('__PROJECT_NAME__', projectName)
		.replaceAll('__CAIRNCMS_VERSION__', cairncmsVersion);

	await fs.writeFile(path.join(appliancePath, 'docker-compose.yml'), rendered);
}

async function ensureDirWithGitkeep(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const gitkeep = path.join(dir, '.gitkeep');
	await fs.writeFile(gitkeep, '');
	logCreated(gitkeep);
}

function logCreated(absolutePath: string): void {
	const rel = path.relative(process.cwd(), absolutePath) || absolutePath;
	process.stdout.write(`${chalk.green('✔')} Created ${rel}\n`);
}
