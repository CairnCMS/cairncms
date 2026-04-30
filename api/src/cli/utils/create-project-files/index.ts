import { promises as fs } from 'node:fs';
import path from 'node:path';

const GITIGNORE = `node_modules
.env
.DS_Store
uploads/*
!uploads/.gitkeep
`;

export default async function createProjectFiles(absolutePath: string): Promise<void> {
	const gitignorePath = path.join(absolutePath, '.gitignore');

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
