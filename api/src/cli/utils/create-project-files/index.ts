import chalk from 'chalk';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_TEMPLATE_PATH = path.resolve(__dirname, '../../templates/README.md');

const GITIGNORE = `# Cairncms Specific
cairncms/data/
cairncms/uploads/
cairncms/extensions/.registry
!cairncms/**/.gitkeep

# Dependencies
node_modules
.pnpm-store

# General Logs
logs/
*.log
npm-debug.log*
pnpm-debug.log*
yarn-debug.log*
yarn-error.log*

# Environment Variables
.env
.env.*
!.env.example
!.env.test

# Deployment Platforms
.netlify/
.vercel/
.wrangler/

# Testing Output
coverage/

# Cache / Temporary
.eslintcache
.stylelintcache

# Certificates
certificates/

# Operating System Files
.DS_Store
Thumbs.db

# IDE / Editor Configs
.idea
.vscode
`;

export interface CreateProjectFilesParams {
	absolutePath: string;
	projectName: string;
	cairncmsPort: number;
}

export default async function createProjectFiles({
	absolutePath,
	projectName,
	cairncmsPort,
}: CreateProjectFilesParams): Promise<void> {
	await writePackageJson({ absolutePath, projectName });
	await writeReadme({ absolutePath, projectName, cairncmsPort });
	await writeGitignore(absolutePath);
}

async function writePackageJson({
	absolutePath,
	projectName,
}: {
	absolutePath: string;
	projectName: string;
}): Promise<void> {
	const target = path.join(absolutePath, 'package.json');

	const content = `${JSON.stringify(
		{
			name: projectName,
			version: '0.1.0',
			private: true,
			scripts: {
				start: 'docker compose --project-directory cairncms -f cairncms/docker-compose.yml up -d',
				stop: 'docker compose --project-directory cairncms -f cairncms/docker-compose.yml down',
				logs: 'docker compose --project-directory cairncms -f cairncms/docker-compose.yml logs -f cairncms',
			},
		},
		null,
		2
	)}\n`;

	await fs.writeFile(target, content);
	logCreated(target);
}

async function writeReadme({
	absolutePath,
	projectName,
	cairncmsPort,
}: {
	absolutePath: string;
	projectName: string;
	cairncmsPort: number;
}): Promise<void> {
	const template = await fs.readFile(README_TEMPLATE_PATH, 'utf8');

	const rendered = template
		.replaceAll('__PROJECT_NAME__', projectName)
		.replaceAll('__CAIRNCMS_PORT__', String(cairncmsPort));

	const target = path.join(absolutePath, 'README.md');
	await fs.writeFile(target, rendered);
	logCreated(target);
}

async function writeGitignore(absolutePath: string): Promise<void> {
	const target = path.join(absolutePath, '.gitignore');
	await fs.writeFile(target, GITIGNORE);
	logCreated(target);
}

function logCreated(absolutePath: string): void {
	const rel = path.relative(process.cwd(), absolutePath) || absolutePath;
	process.stdout.write(`${chalk.green('✔')} Created ${rel}\n`);
}
