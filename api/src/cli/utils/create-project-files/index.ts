import { promises as fs } from 'node:fs';
import path from 'node:path';

const GITIGNORE = `node_modules
.env
uploads
database
dist
.DS_Store
`;

export default async function createProjectFiles(absolutePath: string, projectName: string): Promise<void> {
	const packageJsonPath = path.join(absolutePath, 'package.json');
	const gitignorePath = path.join(absolutePath, '.gitignore');

	if (!(await pathExists(packageJsonPath))) {
		const packageJson = {
			name: toPackageName(projectName),
			private: true,
			scripts: {
				start: 'cairncms start',
				bootstrap: 'cairncms bootstrap',
			},
		};

		await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
	}

	if (!(await pathExists(gitignorePath))) {
		await fs.writeFile(gitignorePath, GITIGNORE);
	}

	await ensureDirWithGitkeep(path.join(absolutePath, 'extensions'));
	await ensureDirWithGitkeep(path.join(absolutePath, 'uploads'));
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

async function ensureDirWithGitkeep(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const gitkeep = path.join(dir, '.gitkeep');

	if (!(await pathExists(gitkeep))) {
		await fs.writeFile(gitkeep, '');
	}
}

function toPackageName(folderName: string): string {
	const sanitized = folderName
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-_.]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-_.]+/, '')
		.replace(/[-_.]+$/, '')
		.slice(0, 214);

	return sanitized || 'cairncms-project';
}
