import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import writeDockerEnv from './write-docker-env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const composePath = path.resolve(here, '../templates/docker-compose.yaml');
const initPath = path.resolve(here, '../commands/init/index.ts');

const tmpDirs: string[] = [];

afterAll(async () => {
	await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('generated deployment artifacts stay in sync', () => {
	it('emits every realtime WEBSOCKETS_* var into .env, the Compose template, and the init strip list', async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-env-'));
		tmpDirs.push(targetDir);

		const { envPath } = await writeDockerEnv({
			secrets: { KEY: 'k', SECRET: 's', DB_PASSWORD: 'd', ADMIN_PASSWORD: 'a' },
			targetDir,
			cairncmsPort: 8055,
		});

		const env = await fs.readFile(envPath, 'utf8');
		const compose = await fs.readFile(composePath, 'utf8');
		const initSrc = await fs.readFile(initPath, 'utf8');

		const wsVars = [...env.matchAll(/^(WEBSOCKETS_[A-Z_]+)=/gm)].map((m) => m[1]!);

		expect(wsVars).toEqual(
			expect.arrayContaining([
				'WEBSOCKETS_ENABLED',
				'WEBSOCKETS_REST_ENABLED',
				'WEBSOCKETS_REST_PATH',
				'WEBSOCKETS_REST_AUTH',
				'WEBSOCKETS_REST_AUTH_TIMEOUT',
				'WEBSOCKETS_REST_CONN_LIMIT',
				'WEBSOCKETS_HEARTBEAT_PERIOD',
				'WEBSOCKETS_USER_CONN_LIMIT',
				'WEBSOCKETS_IP_CONN_LIMIT',
				'WEBSOCKETS_PROCESS_CONN_LIMIT',
			])
		);

		for (const v of wsVars) {
			expect(compose, `${v} has no Compose mapping`).toMatch(new RegExp(`\\b${v}:\\s*\\$\\{${v}\\b`));
			expect(initSrc, `${v} is not in the init shell-strip list`).toContain(`'${v}'`);
		}
	});
});
