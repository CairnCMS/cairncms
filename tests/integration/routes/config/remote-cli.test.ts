import { setupRequest } from '../../fixtures/request';
import { expect } from 'vitest';
import type { Test } from 'supertest';
import type { Api } from '../../fixtures/environment';
import { identityTest as test } from '../../fixtures/identities';
import { describeForVendors } from '../../fixtures/applicability';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'path';
import { dump as dumpYaml } from 'js-yaml';
import * as common from '../../fixtures/data';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const MIN_VERSION = '1.6.0';
const CLI_TIMEOUT = 25000;

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
		{ encoding: 'utf8', timeout: CLI_TIMEOUT }
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

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

function runCli(api: Api, args: string[], env: Record<string, string>) {
	return api.cli(args, { env, timeoutMs: CLI_TIMEOUT });
}

function adminAuth(req: Test): Test {
	return req.set('Authorization', `Bearer ${common.USER.ADMIN!.TOKEN}`);
}

async function findRole(api: Api, roleKey: string): Promise<{ id: string; name: string } | undefined> {
	const response = await adminAuth(
		setupRequest(api.url)
			.get('/roles')
			.query({ filter: JSON.stringify({ key: { _eq: roleKey } }) })
	);

	if (response.statusCode !== 200 || !Array.isArray(response.body?.data)) {
		throw new Error(`unexpected /roles response (${response.statusCode}) while looking up ${roleKey}`);
	}

	return response.body.data[0];
}

describeForVendors(
	'Config-as-Code remote CLI',
	['postgres'],
	'Remote CLI certificate and response validation use PostgreSQL.',
	() => {
		let workDir: string | undefined;
		let proxy: https.Server | undefined;
		let proxyUrl: string;
		let trustedEnv: Record<string, string>;
		let untrustedEnv: Record<string, string>;
		const roleKey = `remotecli_${randomUUID().slice(0, 8)}`;

		test('refuses an untrusted certificate, then snapshots and applies over a trusted https target', async ({
			api,
		}) => {
			let caseError: unknown;

			try {
				workDir = await fs.mkdtemp(path.join(api.directory, 'cairncms-remote-cli-'));
				const { certPath, keyPath } = generateCert(workDir);
				const [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)]);

				proxy = await startProxy(cert, key, api.url);
				proxyUrl = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

				untrustedEnv = {
					CAIRNCMS_TOKEN: common.USER.ADMIN!.TOKEN,
					LOG_LEVEL: 'info',
					LOG_STYLE: 'raw',
				};

				delete untrustedEnv['NODE_EXTRA_CA_CERTS'];
				trustedEnv = { ...untrustedEnv, NODE_EXTRA_CA_CERTS: certPath };

				const untrustedDir = path.join(workDir!, 'untrusted');
				await fs.mkdir(untrustedDir, { recursive: true });

				const untrusted = await runCli(
					api,
					['config', 'snapshot', untrustedDir, '--url', proxyUrl, '--yes'],
					untrustedEnv
				);

				expect(untrusted.status).toBe(3);
				await expect(fs.access(path.join(untrustedDir, 'cairncms-config.yaml'))).rejects.toThrow();

				const configDir = path.join(workDir!, 'config');

				const snapshot = await runCli(api, ['config', 'snapshot', configDir, '--url', proxyUrl, '--yes'], trustedEnv);
				expect(snapshot.status).toBe(0);
				await expect(fs.access(path.join(configDir, 'cairncms-config.yaml'))).resolves.toBeUndefined();

				await fs.writeFile(
					path.join(configDir, 'roles', `${roleKey}.yaml`),
					dumpYaml({ key: roleKey, name: 'Remote CLI Test', admin_access: false, app_access: false })
				);

				const dryRun = await runCli(api, ['config', 'apply', configDir, '--url', proxyUrl, '--dry-run'], trustedEnv);
				expect(dryRun.status).toBe(1);
				expect(dryRun.stdout + dryRun.stderr).toContain(roleKey);

				const dryRunJson = await runCli(
					api,
					['config', 'apply', configDir, '--url', proxyUrl, '--dry-run', '--format', 'json'],
					trustedEnv
				);

				expect(dryRunJson.status).toBe(1);
				const plan = JSON.parse(dryRunJson.stdout);
				expect(plan.planVersion).toBe(2);
				expect(plan.summary.create).toBe(1);

				const apply = await runCli(api, ['config', 'apply', configDir, '--url', proxyUrl, '--yes'], trustedEnv);
				expect(apply.status).toBe(0);
				expect(apply.stdout + apply.stderr).toContain('Config applied: 1 role(s) created');

				const created = await findRole(api, roleKey);
				expect(created).toBeDefined();
				expect(created!.name).toBe('Remote CLI Test');

				const noop = await runCli(api, ['config', 'apply', configDir, '--url', proxyUrl, '--yes'], trustedEnv);
				expect(noop.status).toBe(0);
				expect(noop.stdout + noop.stderr).toContain('No changes to apply.');
				expect(noop.stdout + noop.stderr).not.toContain('Config applied');

				await fs.writeFile(
					path.join(configDir, 'roles', `${roleKey}.yaml`),
					dumpYaml({ key: roleKey, name: 'Remote CLI Renamed', admin_access: false, app_access: false })
				);

				corruptNextMutatingApply = true;
				const corrupted = await runCli(api, ['config', 'apply', configDir, '--url', proxyUrl, '--yes'], trustedEnv);
				const corruptedOutput = corrupted.stdout + corrupted.stderr;

				expect(corruptNextMutatingApply).toBe(false);
				expect(corrupted.status).toBe(3);
				expect(corruptedOutput).toContain('a result that does not match its plan');
				expect(corruptedOutput).toContain('re-snapshot to verify the current state');
				expect(corruptedOutput).toMatch(/Run [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
				expect(corruptedOutput).not.toContain('Config applied');
				expect((await findRole(api, roleKey))!.name).toBe('Remote CLI Renamed');

				await fs.unlink(path.join(configDir, 'roles', `${roleKey}.yaml`));

				const refused = await runCli(api, ['config', 'apply', configDir, '--url', proxyUrl, '--yes'], trustedEnv);
				const refusedOutput = refused.stdout + refused.stderr;

				expect(refused.status).toBe(2);
				expect(refusedOutput).toContain('rejected the request (400)');
				expect(refusedOutput).toContain('deletions');
				expect(refusedOutput).toContain(`Delete ${roleKey}`);
				expect(await findRole(api, roleKey)).toBeDefined();
			} catch (error) {
				caseError = error;
				throw error;
			} finally {
				proxy?.closeAllConnections();

				const results = await Promise.allSettled([
					(async () => {
						const found = await findRole(api, roleKey);
						if (found) await adminAuth(setupRequest(api.url).delete(`/roles/${found.id}`));
						if (await findRole(api, roleKey)) throw new Error(`test role ${roleKey} was not removed`);
					})(),
					new Promise<void>((resolve, reject) => {
						if (!proxy) return resolve();
						proxy.close((err) => (err ? reject(err) : resolve()));
					}),
					workDir ? fs.rm(workDir, { recursive: true, force: true }) : Promise.resolve(),
				]);

				const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

				reportCleanupFailures(failures, caseError);
			}
		}, 120000);
	}
);

function reportCleanupFailures(failures: PromiseRejectedResult[], caseError: unknown) {
	if (failures.length)
		throw new AggregateError(
			[...(caseError === undefined ? [] : [caseError]), ...failures.map((failure) => failure.reason)],
			'Configuration CLI scenario cleanup failed'
		);
}
