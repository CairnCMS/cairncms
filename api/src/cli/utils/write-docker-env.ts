import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GeneratedSecrets } from './generate-secrets.js';

export interface DockerEnvParams {
	secrets: GeneratedSecrets;
	cairncmsImageTag: string;
	targetDir: string;
}

export default async function writeDockerEnv({
	secrets,
	cairncmsImageTag,
	targetDir,
}: DockerEnvParams): Promise<string> {
	const envPath = path.join(targetDir, '.env');

	const content = [
		`KEY="${secrets.KEY}"`,
		`SECRET="${secrets.SECRET}"`,
		'',
		'DB_CLIENT="pg"',
		'DB_HOST="database"',
		'DB_PORT=5432',
		'DB_DATABASE="cairncms"',
		'DB_USER="cairncms"',
		`DB_PASSWORD="${secrets.DB_PASSWORD}"`,
		'',
		'ADMIN_EMAIL="admin@example.com"',
		`ADMIN_PASSWORD="${secrets.ADMIN_PASSWORD}"`,
		'',
		'PUBLIC_URL="http://localhost:8055"',
		`CAIRNCMS_IMAGE_TAG="${cairncmsImageTag}"`,
		'',
	].join('\n');

	await fs.writeFile(envPath, content);
	await fs.chmod(envPath, 0o600);

	return envPath;
}
