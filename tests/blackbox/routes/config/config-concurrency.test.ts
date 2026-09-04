import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import config, { getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { dump as dumpYaml } from 'js-yaml';

const CONFIRM_PROMPT = 'Would you like to continue?';
const RUN_EVENT = 'config.run.finished';
const PROMPT_TIMEOUT = 25000;

function adminAuth(req: request.Test): request.Test {
	return req.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);
}

async function findRole(vendor: string, key: string): Promise<{ id: string; name: string } | undefined> {
	const response = await adminAuth(
		request(getUrl(vendor))
			.get('/roles')
			.query({ filter: JSON.stringify({ key: { _eq: key } }) })
	);

	return response.body?.data?.[0];
}

function findRunRecord(output: string): { result?: string; event?: string; errorCode?: string } | undefined {
	for (const line of output.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;

		try {
			const parsed = JSON.parse(trimmed);
			if (parsed?.event === RUN_EVENT) return parsed;
		} catch {
			// not a JSON record line
		}
	}

	return undefined;
}

type InteractiveApply = {
	child: ChildProcess;
	atPrompt: Promise<void>;
	awaitClose: (ms: number) => Promise<number | null>;
	output: () => string;
	dispose: () => Promise<void>;
};

function spawnInteractiveApply(vendor: string, fixtureRoot: string): InteractiveApply {
	const env = { ...config.envs[vendor as keyof typeof config.envs], LOG_LEVEL: 'info', LOG_STYLE: 'raw' };

	const child = spawn('node', ['--no-node-snapshot', paths.cli, 'config', 'apply', fixtureRoot], {
		cwd: paths.cwd,
		env,
	});

	let stdout = '';
	let stderr = '';
	let exited = false;

	const closed = new Promise<number | null>((resolve, reject) => {
		child.on('close', (code) => {
			exited = true;
			resolve(code);
		});

		child.on('error', (err) => {
			exited = true;
			reject(err);
		});
	});

	const atPrompt = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error('CLI never reached the confirmation prompt'));
		}, PROMPT_TIMEOUT);

		child.stdout.on('data', (chunk) => {
			stdout += chunk;

			if (stdout.includes(CONFIRM_PROMPT)) {
				clearTimeout(timer);
				resolve();
			}
		});

		child.on('close', () => {
			clearTimeout(timer);
			reject(new Error('CLI exited before reaching the confirmation prompt'));
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});

	child.stderr.on('data', (chunk) => (stderr += chunk));

	async function awaitClose(ms: number): Promise<number | null> {
		let timer: ReturnType<typeof setTimeout>;

		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				child.kill('SIGKILL');
				closed.then(() => reject(new Error('CLI did not exit after the confirmation')), reject);
			}, ms);
		});

		try {
			return await Promise.race([closed, deadline]);
		} finally {
			clearTimeout(timer!);
		}
	}

	async function dispose(): Promise<void> {
		if (!exited) {
			child.kill('SIGKILL');
			await closed.catch(() => undefined);
		}
	}

	return { child, atPrompt, awaitClose, output: () => stdout + stderr, dispose };
}

describe('Config-as-Code local confirmation-window concurrency', () => {
	let workDir: string | undefined;

	afterEach(async () => {
		if (workDir) await fs.rm(workDir, { recursive: true, force: true });
		workDir = undefined;
	});

	it.each(vendors)(
		'%s refuses a confirmed apply whose managed state changed while the operator was at the prompt',
		async (vendor) => {
			workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-config-cw-'));
			const fixtureRoot = path.join(workDir, 'config');
			await fs.mkdir(fixtureRoot, { recursive: true });

			const suffix = `${vendor.replace(/[^a-z0-9]/gi, '')}_${randomUUID().slice(0, 8)}`;
			const baseKey = `cw_base_${suffix}`;
			const newKey = `cw_new_${suffix}`;

			const baseCreate = await adminAuth(
				request(getUrl(vendor))
					.post('/roles')
					.send({ key: baseKey, name: 'CW Base', admin_access: false, app_access: false })
			);

			expect(baseCreate.statusCode).toBe(200);
			const baseId = baseCreate.body.data.id as string;

			try {
				const snapshot = spawnSync(
					'node',
					['--no-node-snapshot', paths.cli, 'config', 'snapshot', fixtureRoot, '--yes'],
					{ cwd: paths.cwd, env: config.envs[vendor as keyof typeof config.envs], encoding: 'utf8' }
				);

				expect(snapshot.status).toBe(0);

				await fs.writeFile(
					path.join(fixtureRoot, 'roles', `${newKey}.yaml`),
					dumpYaml({ key: newKey, name: 'CW New', admin_access: false, app_access: false })
				);

				const proc = spawnInteractiveApply(vendor, fixtureRoot);

				try {
					await proc.atPrompt;

					const rename = await adminAuth(
						request(getUrl(vendor)).patch(`/roles/${baseId}`).send({ name: 'Renamed In Window' })
					);

					expect(rename.statusCode).toBe(200);

					proc.child.stdin!.write('y\n');
					proc.child.stdin!.end();

					const code = await proc.awaitClose(20000);
					const record = findRunRecord(proc.output());

					expect(code).toBe(2);
					expect(record?.result).toBe('state_changed');
					expect(record?.errorCode).toBe('CONFIG_STATE_CHANGED');

					expect(await findRole(vendor, newKey)).toBeUndefined();
					expect((await findRole(vendor, baseKey))?.name).toBe('Renamed In Window');
				} finally {
					await proc.dispose();
				}
			} finally {
				const created = await findRole(vendor, newKey);
				if (created) await adminAuth(request(getUrl(vendor)).delete(`/roles/${created.id}`));
				await adminAuth(request(getUrl(vendor)).delete(`/roles/${baseId}`));
			}
		},
		90000
	);
});
