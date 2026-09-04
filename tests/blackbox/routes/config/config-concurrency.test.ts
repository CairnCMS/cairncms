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
import knex, { type Knex } from 'knex';

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

type ConfigSnapshot = {
	manifest: { version: number; resources: string[] };
	roles: Array<{ key: string; name?: string }>;
	permissions: Array<{ role: string; permissions: Array<Record<string, unknown>> }>;
};

// The single-connection SQLite deadlock is vendor-specific, so the hook proof runs on SQLite only.
const sqliteVendors = vendors.filter((vendor) => vendor === 'sqlite3');
const hookDescribe = sqliteVendors.length > 0 ? describe : describe.skip;

hookDescribe('Config-as-Code transaction-bound role hook uses the supplied database', () => {
	const databases = new Map<string, Knex>();

	beforeAll(() => {
		for (const vendor of sqliteVendors) databases.set(vendor, knex(config.knexConfig[vendor]!));
	});

	afterAll(async () => {
		for (const [, db] of databases) await db.destroy();
	});

	function markerKey(kind: string, roleId: string): string {
		return `config-apply-probe/roles.update.${kind}/${roleId}`;
	}

	async function markerCount(vendor: string, kind: string, roleId: string): Promise<number> {
		const rows = await databases.get(vendor)!('tests_extensions_log')
			.where({ key: markerKey(kind, roleId) })
			.select('id');

		return rows.length;
	}

	async function clearMarkers(vendor: string, roleId: string): Promise<void> {
		await databases.get(vendor)!('tests_extensions_log')
			.where('key', 'like', `config-apply-probe/roles.update.%/${roleId}`)
			.delete();
	}

	async function createProbeRole(vendor: string): Promise<{ id: string; key: string }> {
		const key = `hookprobe_${vendor.replace(/[^a-z0-9]/gi, '')}_${randomUUID().slice(0, 8)}`;

		const created = await adminAuth(
			request(getUrl(vendor)).post('/roles').send({ key, name: 'Hook Probe', admin_access: false, app_access: false })
		);

		expect(created.statusCode).toBe(200);
		return { id: created.body.data.id as string, key };
	}

	it.each(sqliteVendors)(
		'%s: a role update whose filter reads through the supplied database completes and writes both markers',
		async (vendor) => {
			const role = await createProbeRole(vendor);

			try {
				const update = await adminAuth(
					request(getUrl(vendor)).patch(`/roles/${role.id}`).send({ name: 'Hook Probed' })
				);

				expect(update.statusCode).toBe(200);
				expect(await markerCount(vendor, 'dbfilter', role.id)).toBe(1);
				expect(await markerCount(vendor, 'dbaction', role.id)).toBe(1);

				const stored = await databases.get(vendor)!('directus_roles').where({ id: role.id }).first();
				expect(stored.name).toBe('Hook Probed');
			} finally {
				await clearMarkers(vendor, role.id);
				await adminAuth(request(getUrl(vendor)).delete(`/roles/${role.id}`));
			}
		},
		60000
	);

	it.each(sqliteVendors)(
		'%s: a config apply that fails after the role-update filter ran rolls back the role, the filter marker, and the action',
		async (vendor) => {
			const role = await createProbeRole(vendor);

			try {
				const snapshotResponse = await adminAuth(request(getUrl(vendor)).get('/config/snapshot'));
				expect(snapshotResponse.statusCode).toBe(200);
				const baseline = snapshotResponse.body.data as ConfigSnapshot;

				const desired = JSON.parse(JSON.stringify(baseline)) as ConfigSnapshot;
				const target = desired.roles.find((entry) => entry.key === role.key);
				expect(target).toBeDefined();
				target!.name = 'Renamed By Apply';

				let permissionSet = desired.permissions.find((entry) => entry.role === role.key);

				if (!permissionSet) {
					permissionSet = { role: role.key, permissions: [] };
					desired.permissions.push(permissionSet);
				}

				permissionSet.permissions.push({
					collection: 'hookprobe_rollback',
					action: 'read',
					permissions: {},
					validation: null,
					presets: null,
					fields: ['*'],
				});

				const dryRun = await adminAuth(request(getUrl(vendor)).post('/config/apply?dry_run=true').send(desired));
				expect(dryRun.statusCode).toBe(200);
				const changes = dryRun.body.data.changes as Array<Record<string, any>>;

				expect(changes.some((c) => c.kind === 'roles' && c.operation === 'update' && c.identity.key === role.key)).toBe(
					true
				);

				expect(
					changes.some((c) => c.kind === 'permissions' && c.operation === 'create' && c.identity.role === role.key)
				).toBe(true);

				// The later permission-phase filter throws a typed exception, so a role-phase failure of the
				// hook under test would surface differently and fail this assertion rather than pass vacuously.
				const apply = await adminAuth(request(getUrl(vendor)).post('/config/apply').send(desired));
				expect(apply.statusCode).toBe(400);
				expect(apply.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
				expect(apply.body.errors[0].message).toContain('forced permission-phase rollback');

				const stored = await databases.get(vendor)!('directus_roles').where({ id: role.id }).first();
				expect(stored.name).toBe('Hook Probe');

				expect(await markerCount(vendor, 'dbfilter', role.id)).toBe(0);
				expect(await markerCount(vendor, 'dbaction', role.id)).toBe(0);
			} finally {
				await clearMarkers(vendor, role.id);
				await adminAuth(request(getUrl(vendor)).delete(`/roles/${role.id}`));
			}
		},
		60000
	);
});
