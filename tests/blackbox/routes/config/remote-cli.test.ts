import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'os';
import path from 'path';
import { dump as dumpYaml } from 'js-yaml';
import request from 'supertest';
import config, { getUrl, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';

const VENDOR = 'postgres';
const MIN_VERSION = '1.6.0';
const CLI_TIMEOUT = 25000;
const runsPostgres = vendors.includes(VENDOR);

type CliResult = { status: number | null; stdout: string; stderr: string };

let corruptNextMutatingApply = false;

function rewriteUpstreamPayload(req: http.IncomingMessage, status: number, payload: Buffer): Buffer {
	const url = req.url ?? '';
	const pathname = url.split('?')[0];

	if (pathname === '/server/info' && req.method === 'GET') {
		try {
			const parsed = JSON.parse(payload.toString('utf8'));
			if (parsed?.data?.cairncms) parsed.data.cairncms.version = MIN_VERSION;
			return Buffer.from(JSON.stringify(parsed));
		} catch {
			return payload;
		}
	}

	const mutatingApply = pathname === '/config/apply' && req.method === 'POST' && !url.includes('dry_run=true');

	if (mutatingApply && corruptNextMutatingApply && status >= 200 && status < 300) {
		corruptNextMutatingApply = false;

		try {
			const parsed = JSON.parse(payload.toString('utf8'));
			if (Array.isArray(parsed?.data?.roles?.updated)) parsed.data.roles.updated.push('phantom');
			return Buffer.from(JSON.stringify(parsed));
		} catch {
			return payload;
		}
	}

	return payload;
}

function generateCert(dir: string): { certPath: string; keyPath: string } {
	const certPath = path.join(dir, 'cert.pem');
	const keyPath = path.join(dir, 'key.pem');

	const result = spawnSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-days',
			'1',
			'-subj',
			'/CN=127.0.0.1',
			'-addext',
			'subjectAltName=IP:127.0.0.1',
		],
		{ encoding: 'utf8' }
	);

	if (result.status !== 0) {
		throw new Error(`openssl failed to generate a test certificate: ${result.stderr}`);
	}

	return { certPath, keyPath };
}

function startProxy(cert: Buffer, key: Buffer, upstream: string): Promise<https.Server> {
	const target = new URL(upstream);

	const server = https.createServer({ cert, key }, (req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(chunk));

		req.on('end', () => {
			const body = Buffer.concat(chunks);
			const headers = { ...req.headers };
			delete headers['accept-encoding'];
			delete headers['host'];

			const upstreamReq = http.request(
				{ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers },
				(upstreamRes) => {
					const responseChunks: Buffer[] = [];
					upstreamRes.on('data', (chunk) => responseChunks.push(chunk));

					upstreamRes.on('end', () => {
						const status = upstreamRes.statusCode ?? 502;
						const payload = rewriteUpstreamPayload(req, status, Buffer.concat(responseChunks));
						const responseHeaders = { ...upstreamRes.headers };
						delete responseHeaders['content-length'];

						res.writeHead(status, responseHeaders);
						res.end(payload);
					});
				}
			);

			upstreamReq.on('error', () => {
				res.writeHead(502);
				res.end();
			});

			if (body.length > 0) upstreamReq.write(body);
			upstreamReq.end();
		});
	});

	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('node', ['--no-node-snapshot', paths.cli, ...args], { cwd: paths.cwd, env });

		let stdout = '';
		let stderr = '';
		let timedOut = false;
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, CLI_TIMEOUT);

		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});

		child.on('close', (status) => {
			clearTimeout(timer);
			if (timedOut) reject(new Error(`CLI timed out: config ${args.join(' ')}`));
			else resolve({ status, stdout, stderr });
		});
	});
}

function adminAuth(req: request.Test): request.Test {
	return req.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);
}

async function findRole(roleKey: string): Promise<{ id: string; name: string } | undefined> {
	const response = await adminAuth(
		request(getUrl(VENDOR))
			.get('/roles')
			.query({ filter: JSON.stringify({ key: { _eq: roleKey } }) })
	);

	if (response.statusCode !== 200 || !Array.isArray(response.body?.data)) {
		throw new Error(`unexpected /roles response (${response.statusCode}) while looking up ${roleKey}`);
	}

	return response.body.data[0];
}

describe('Config-as-Code remote CLI', () => {
	let workDir: string | undefined;
	let proxy: https.Server | undefined;
	let proxyUrl: string;
	let trustedEnv: NodeJS.ProcessEnv;
	let untrustedEnv: NodeJS.ProcessEnv;
	const roleKey = `remotecli_${randomUUID().slice(0, 8)}`;

	beforeAll(async () => {
		if (!runsPostgres) return;

		workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-remote-cli-'));
		const { certPath, keyPath } = generateCert(workDir);
		const [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)]);

		proxy = await startProxy(cert, key, getUrl(VENDOR));
		proxyUrl = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

		untrustedEnv = {
			...config.envs[VENDOR],
			CAIRNCMS_TOKEN: common.USER.ADMIN!.TOKEN,
			LOG_LEVEL: 'info',
			LOG_STYLE: 'raw',
		};

		delete untrustedEnv['NODE_EXTRA_CA_CERTS'];
		trustedEnv = { ...untrustedEnv, NODE_EXTRA_CA_CERTS: certPath };
	});

	afterAll(async () => {
		if (!runsPostgres) return;

		const results = await Promise.allSettled([
			(async () => {
				const found = await findRole(roleKey);
				if (found) await adminAuth(request(getUrl(VENDOR)).delete(`/roles/${found.id}`));
				if (await findRole(roleKey)) throw new Error(`test role ${roleKey} was not removed`);
			})(),
			new Promise<void>((resolve, reject) => {
				if (!proxy) return resolve();
				proxy.close((err) => (err ? reject(err) : resolve()));
			}),
			workDir ? fs.rm(workDir, { recursive: true, force: true }) : Promise.resolve(),
		]);

		const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

		if (failures.length > 0) {
			throw new Error(`remote CLI teardown failed: ${failures.map((failure) => String(failure.reason)).join(', ')}`);
		}
	});

	(runsPostgres ? it : it.skip)(
		'refuses an untrusted certificate, then snapshots and applies over a trusted https target',
		async () => {
			const untrustedDir = path.join(workDir!, 'untrusted');
			await fs.mkdir(untrustedDir, { recursive: true });

			const untrusted = await runCli(['config', 'snapshot', untrustedDir, '--url', proxyUrl, '--yes'], untrustedEnv);
			expect(untrusted.status).toBe(3);
			await expect(fs.access(path.join(untrustedDir, 'cairncms-config.yaml'))).rejects.toThrow();

			const configDir = path.join(workDir!, 'config');

			const snapshot = await runCli(['config', 'snapshot', configDir, '--url', proxyUrl, '--yes'], trustedEnv);
			expect(snapshot.status).toBe(0);
			await expect(fs.access(path.join(configDir, 'cairncms-config.yaml'))).resolves.toBeUndefined();

			await fs.writeFile(
				path.join(configDir, 'roles', `${roleKey}.yaml`),
				dumpYaml({ key: roleKey, name: 'Remote CLI Test', admin_access: false, app_access: false })
			);

			const dryRun = await runCli(['config', 'apply', configDir, '--url', proxyUrl, '--dry-run'], trustedEnv);
			expect(dryRun.status).toBe(1);
			expect(dryRun.stdout + dryRun.stderr).toContain(roleKey);

			const dryRunJson = await runCli(
				['config', 'apply', configDir, '--url', proxyUrl, '--dry-run', '--format', 'json'],
				trustedEnv
			);

			expect(dryRunJson.status).toBe(1);
			const plan = JSON.parse(dryRunJson.stdout);
			expect(plan.planVersion).toBe(2);
			expect(plan.summary.create).toBe(1);

			const apply = await runCli(['config', 'apply', configDir, '--url', proxyUrl, '--yes'], trustedEnv);
			expect(apply.status).toBe(0);

			const created = await findRole(roleKey);
			expect(created).toBeDefined();
			expect(created!.name).toBe('Remote CLI Test');

			await fs.writeFile(
				path.join(configDir, 'roles', `${roleKey}.yaml`),
				dumpYaml({ key: roleKey, name: 'Remote CLI Renamed', admin_access: false, app_access: false })
			);

			corruptNextMutatingApply = true;
			const corrupted = await runCli(['config', 'apply', configDir, '--url', proxyUrl, '--yes'], trustedEnv);
			const corruptedOutput = corrupted.stdout + corrupted.stderr;

			expect(corruptNextMutatingApply).toBe(false);
			expect(corrupted.status).toBe(3);
			expect(corruptedOutput).toContain('a result that does not match its plan');
			expect(corruptedOutput).toContain('re-snapshot to verify the current state');
			expect(corruptedOutput).toMatch(/Run [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
			expect(corruptedOutput).not.toContain('Config applied');
			expect((await findRole(roleKey))!.name).toBe('Remote CLI Renamed');
		},
		120000
	);
});
