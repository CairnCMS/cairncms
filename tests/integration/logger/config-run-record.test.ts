import { setupRequest } from '../fixtures/request';
import { expect } from 'vitest';
import { StringDecoder } from 'node:string_decoder';
import type { Test } from 'supertest';
import type { Api } from '../fixtures/environment';
import { createIdentityTest } from '../fixtures/identities';
import { describeForVendors } from '../fixtures/applicability';
import * as common from '../fixtures/data';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dump as dumpYaml } from 'js-yaml';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'path';
import { initializeFixtures } from '../harness/fixture-setup.mjs';

const test = createIdentityTest({
	env: { LOG_LEVEL: 'info', LOG_STYLE: 'raw', CORS_ENABLED: 'true', CORS_ORIGIN: 'true' },
});

initializeFixtures();

const MIN_VERSION = '1.6.0';
const RUN_EVENT = 'config.run.finished';
const RUN_ID_HEADER = 'x-config-run-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_LINE = /Run ([0-9a-f-]{36})/;
const CLI_TIMEOUT = 25000;

type RunRecord = {
	event: string;
	runId?: string;
	source: string;
	caller: { kind: string; origin?: string };
	userAgent?: string;
	dryRun: boolean;
	destructive: boolean;
	result: string;
	errorCode?: string;
	changes?: { create: number; update: number; delete: number };
	durationMs: number;
};

function parseRecords(text: string): RunRecord[] {
	const records: RunRecord[] = [];

	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;

		let parsed: unknown;

		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (typeof parsed === 'object' && parsed !== null && (parsed as RunRecord).event === RUN_EVENT) {
			records.push(parsed as RunRecord);
		}
	}

	return records;
}

function startProxy(upstream: string): Promise<http.Server> {
	const target = new URL(upstream);

	const server = http.createServer((req, res) => {
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
						let payload = Buffer.concat(responseChunks);
						const responseHeaders = { ...upstreamRes.headers };
						delete responseHeaders['content-length'];

						if ((req.url ?? '').split('?')[0] === '/server/info' && req.method === 'GET') {
							try {
								const parsed = JSON.parse(payload.toString('utf8'));
								if (parsed?.data?.cairncms) parsed.data.cairncms.version = MIN_VERSION;
								payload = Buffer.from(JSON.stringify(parsed));
							} catch {
								// forward a non-JSON body untouched
							}
						}

						res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
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

async function findRole(api: Api, roleKey: string): Promise<{ id: string } | undefined> {
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
	'Config-as-Code run record',
	['postgres'],
	'Config run-record logging is validated against PostgreSQL.',
	() => {
		let serverLogs = '';
		let proxy: http.Server | undefined;
		let proxyUrl: string;
		let workDir: string | undefined;
		let configDir: string;
		let baseline: unknown;
		let cliEnv: Record<string, string>;
		const roleKey = `runrecord_${randomUUID().slice(0, 8)}`;

		function serverRecords(): RunRecord[] {
			return parseRecords(serverLogs);
		}

		async function waitForRecords(predicate: (record: RunRecord) => boolean): Promise<RunRecord[]> {
			const deadline = Date.now() + 10000;

			while (Date.now() < deadline) {
				const matched = serverRecords().filter(predicate);
				if (matched.length > 0) return matched;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			return serverRecords().filter(predicate);
		}

		function apply(api: Api, body: unknown, query: Record<string, string> = {}): Test {
			return adminAuth(setupRequest(api.url).post('/config/apply').query(query))
				.set('User-Agent', 'blackbox-run-record/1.0')
				.send(body as object);
		}

		test('emits exactly one record per run on every surface and returns the run id to HTTP callers', async ({
			api,
		}) => {
			const decoder = new StringDecoder('utf8');

			const capture = (chunk: Buffer) => {
				serverLogs += decoder.write(chunk);
			};

			api.child.stdout!.on('data', capture);

			let caseError: unknown;

			try {
				proxy = await startProxy(api.url);
				proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

				workDir = await fs.mkdtemp(path.join(api.directory, 'cairncms-run-record-'));
				configDir = path.join(workDir, 'config');

				cliEnv = { CAIRNCMS_TOKEN: common.USER.ADMIN!.TOKEN, LOG_LEVEL: 'info', LOG_STYLE: 'raw' };

				const snapshot = await adminAuth(setupRequest(api.url).get('/config/snapshot'));
				if (snapshot.statusCode !== 200) throw new Error(`snapshot failed (${snapshot.statusCode})`);
				baseline = snapshot.body.data;

				const localSnapshot = await runCli(api, ['config', 'snapshot', configDir, '--yes'], cliEnv);
				expect(localSnapshot.status).toBe(0);

				const localDryRun = await runCli(api, ['config', 'apply', configDir, '--dry-run'], cliEnv);
				expect(localDryRun.status).toBe(0);
				const localDryRunRecords = parseRecords(localDryRun.stdout);
				expect(localDryRunRecords).toHaveLength(1);

				expect(localDryRunRecords[0]).toMatchObject({
					source: 'cli',
					caller: { kind: 'system', origin: 'config-cli' },
					dryRun: true,
					result: 'no_changes',
				});

				expect(localDryRunRecords[0]).not.toHaveProperty('runId');
				expect(localDryRunRecords[0]).not.toHaveProperty('userAgent');

				const prettyDryRun = await runCli(api, ['config', 'apply', configDir, '--dry-run'], {
					...cliEnv,
					LOG_STYLE: 'pretty',
				});

				expect(prettyDryRun.status).toBe(0);
				expect(parseRecords(prettyDryRun.stdout + prettyDryRun.stderr)).toHaveLength(0);
				expect(prettyDryRun.stdout + prettyDryRun.stderr).not.toContain(RUN_EVENT);

				await fs.writeFile(
					path.join(configDir, 'roles', `${roleKey}.yaml`),
					dumpYaml({ key: roleKey, name: 'Run Record Test', admin_access: false, app_access: false })
				);

				const localApply = await runCli(api, ['config', 'apply', configDir, '--yes'], cliEnv);
				expect(localApply.status).toBe(0);
				const localApplyRecords = parseRecords(localApply.stdout);
				expect(localApplyRecords).toHaveLength(1);

				expect(localApplyRecords[0]).toMatchObject({
					source: 'cli',
					dryRun: false,
					result: 'applied',
					changes: { create: 1, update: 0, delete: 0 },
				});

				expect(localApplyRecords[0]).not.toHaveProperty('runId');
				expect(await findRole(api, roleKey)).toBeDefined();

				const httpDryRun = await apply(api, baseline, { dry_run: 'true' }).set('Origin', 'https://app.example');
				expect(httpDryRun.statusCode).toBe(200);
				const dryRunId = httpDryRun.headers[RUN_ID_HEADER];
				expect(dryRunId).toMatch(UUID);
				expect(httpDryRun.headers['access-control-expose-headers']).toContain('X-Config-Run-Id');
				const dryRunRecords = await waitForRecords((record) => record.runId === dryRunId);
				expect(dryRunRecords).toHaveLength(1);

				expect(dryRunRecords[0]).toMatchObject({
					source: 'http',
					caller: { kind: 'user' },
					userAgent: 'blackbox-run-record/1.0',
					dryRun: true,
					result: 'planned',
					changes: { create: 0, update: 0, delete: 1 },
				});

				const refused = await apply(api, baseline).expect(400);
				expect(refused.statusCode).toBe(400);
				expect(refused.body.errors[0].extensions.code).toBe('DESTRUCTIVE_CHANGES_REQUIRED');
				const refusedId = refused.headers[RUN_ID_HEADER];
				expect(refusedId).toMatch(UUID);
				const refusedRecords = await waitForRecords((record) => record.runId === refusedId);
				expect(refusedRecords).toHaveLength(1);

				expect(refusedRecords[0]).toMatchObject({
					source: 'http',
					dryRun: false,
					destructive: false,
					result: 'refused',
					errorCode: 'DESTRUCTIVE_CHANGES_REQUIRED',
				});

				const remoteDryRun = await runCli(api, ['config', 'apply', configDir, '--url', proxyUrl, '--dry-run'], cliEnv);
				expect(remoteDryRun.status).toBe(0);
				const remoteOutput = remoteDryRun.stdout + remoteDryRun.stderr;
				expect(remoteOutput).not.toContain(RUN_EVENT);
				const remoteRunId = RUN_LINE.exec(remoteOutput)?.[1];
				expect(remoteRunId).toMatch(UUID);
				const remoteRecords = await waitForRecords((record) => record.runId === remoteRunId);
				expect(remoteRecords).toHaveLength(1);
				expect(remoteRecords[0]).toMatchObject({ source: 'http', dryRun: true, result: 'no_changes' });
				expect(remoteRecords[0]!.userAgent).toMatch(/^cairncms-cli\//);

				const remoteJson = await runCli(
					api,
					['config', 'apply', configDir, '--url', proxyUrl, '--dry-run', '--format', 'json'],
					cliEnv
				);

				expect(remoteJson.status).toBe(0);
				expect(JSON.parse(remoteJson.stdout).planVersion).toBe(2);
				expect(remoteJson.stdout).not.toContain(RUN_EVENT);
				const remoteJsonId = RUN_LINE.exec(remoteJson.stderr)?.[1];
				expect(remoteJsonId).toMatch(UUID);
				expect(await waitForRecords((record) => record.runId === remoteJsonId)).toHaveLength(1);

				const httpApply = await apply(api, baseline, { destructive: 'true' });
				expect(httpApply.statusCode).toBe(200);
				const applyId = httpApply.headers[RUN_ID_HEADER];
				const applyRecords = await waitForRecords((record) => record.runId === applyId);
				expect(applyRecords).toHaveLength(1);

				expect(applyRecords[0]).toMatchObject({
					source: 'http',
					destructive: true,
					result: 'applied',
					changes: { create: 0, update: 0, delete: 1 },
				});

				expect(await findRole(api, roleKey)).toBeUndefined();

				const allRecords = serverRecords();

				expect(allRecords.map((record) => record.runId)).toEqual([
					dryRunId,
					refusedId,
					remoteRunId,
					remoteJsonId,
					applyId,
				]);
			} catch (error) {
				caseError = error;
				throw error;
			} finally {
				api.child.stdout!.off('data', capture);
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
