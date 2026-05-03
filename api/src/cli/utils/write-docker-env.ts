import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GeneratedSecrets } from './generate-secrets.js';

export interface DockerEnvParams {
	secrets: GeneratedSecrets;
	targetDir: string;
	cairncmsPort: number;
}

const PLACEHOLDER_SECRETS: GeneratedSecrets = {
	KEY: 'your-key-here',
	SECRET: 'your-secret-here',
	DB_PASSWORD: 'your-db-password-here',
	ADMIN_PASSWORD: 'your-admin-password-here',
};

export default async function writeDockerEnv({ secrets, targetDir, cairncmsPort }: DockerEnvParams): Promise<{
	envPath: string;
	envExamplePath: string;
}> {
	const envPath = path.join(targetDir, '.env');
	const envExamplePath = path.join(targetDir, '.env.example');

	await fs.writeFile(envPath, renderEnv(secrets, cairncmsPort));
	await fs.chmod(envPath, 0o600);

	await fs.writeFile(envExamplePath, renderEnv(PLACEHOLDER_SECRETS, cairncmsPort));

	return { envPath, envExamplePath };
}

function renderEnv(secrets: GeneratedSecrets, cairncmsPort: number): string {
	return [
		'# Database Configuration',
		'DB_USER=cairncms',
		`DB_PASSWORD="${secrets.DB_PASSWORD}"`,
		'DB_DATABASE=cairncms',
		'',
		'# Cairncms Configuration',
		`CAIRNCMS_PORT=${cairncmsPort}`,
		`KEY="${secrets.KEY}"`,
		`SECRET="${secrets.SECRET}"`,
		'',
		'# Admin Configuration (created by bootstrap on first container start)',
		'ADMIN_EMAIL=admin@example.com',
		`ADMIN_PASSWORD="${secrets.ADMIN_PASSWORD}"`,
		'',
		'# Cache Configuration',
		'CACHE_ENABLED=true',
		'CACHE_AUTO_PURGE=true',
		'',
		'# WebSocket Configuration',
		'WEBSOCKETS_ENABLED=true',
		'',
		'# CORS Configuration',
		'CORS_ENABLED=true',
		'CORS_ORIGIN=*',
		'',
		'# Cookie Configuration',
		'REFRESH_TOKEN_COOKIE_SECURE=false',
		'REFRESH_TOKEN_COOKIE_SAME_SITE=lax',
		'REFRESH_TOKEN_COOKIE_DOMAIN=localhost',
		'',
		'SESSION_COOKIE_SECURE=false',
		'SESSION_COOKIE_SAME_SITE=lax',
		'SESSION_COOKIE_DOMAIN=localhost',
		'',
		'# Extensions Configuration',
		'EXTENSIONS_PATH=./extensions',
		'EXTENSIONS_AUTO_RELOAD=true',
		'',
		'# Email Configuration',
		'EMAIL_TRANSPORT=sendmail',
		'EMAIL_FROM=no-reply@example.com',
		'EMAIL_SMTP_HOST=',
		'EMAIL_SMTP_PORT=',
		'EMAIL_SMTP_USER=',
		'EMAIL_SMTP_PASSWORD=',
		'',
	].join('\n');
}
