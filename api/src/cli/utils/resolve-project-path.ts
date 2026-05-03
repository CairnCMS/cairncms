import chalk from 'chalk';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import inquirer from 'inquirer';

export interface ResolvedProjectPath {
	absolutePath: string;
	name: string;
	appliancePath: string;
	isCurrentDir: boolean;
}

const DEFAULT_PROJECT_NAME = 'cairncms-project';
const INVALID_NAME_PATTERN = /[\\/:*?"<>|]/;

export default async function resolveProjectPath(positional: string | undefined): Promise<ResolvedProjectPath> {
	const cwd = process.cwd();
	const raw = positional ?? (await promptForName());
	const isCurrentDir = raw === '.' || path.resolve(raw) === cwd;

	if (isCurrentDir) {
		process.stdout.write(
			`\n${chalk.red(
				'Error:'
			)} Initializing in the current directory is not yet supported. Pass a project name instead, e.g. ${chalk.blue(
				'cairncms init my-cms'
			)}.\n`
		);

		process.exit(1);
	}

	const absolutePath = path.resolve(raw);
	const name = path.basename(absolutePath);

	if (existsSync(absolutePath)) {
		process.stdout.write(
			`\n${chalk.red('Error:')} ${chalk.green(absolutePath)} already exists. Choose another name or remove it first.\n`
		);

		process.exit(1);
	}

	mkdirSync(absolutePath, { recursive: true });

	const appliancePath = path.join(absolutePath, 'cairncms');

	return { absolutePath, name, appliancePath, isCurrentDir };
}

async function promptForName(): Promise<string> {
	const { name } = await inquirer.prompt([
		{
			type: 'input',
			name: 'name',
			message: 'Project name:',
			default: DEFAULT_PROJECT_NAME,
			validate: (input: string) => {
				const trimmed = input.trim();
				if (!trimmed) return 'Project name is required';
				if (INVALID_NAME_PATTERN.test(trimmed)) return 'Project name contains invalid characters';
				return true;
			},
		},
	]);

	return name.trim();
}
