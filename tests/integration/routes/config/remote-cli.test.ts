import { setupRequest } from '../../fixtures/request';
import { expect, vi } from 'vitest';
import type { Test } from 'supertest';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest } from '../../fixtures/identities';
import { describeForVendors } from '../../fixtures/applicability';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'path';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { sortBy } from 'lodash';
import * as common from '../../fixtures/data';
import { CreateCollection, CreateField } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import {
	assertDocsLabAbsent,
	assertDocsLabRestored,
	createDocsLab,
	docsManifest,
	docsSnapshot,
	DOCS_FOLDER,
	DOCS_ROLE,
	recordDocsEvidence,
	removeDocsLab,
} from '../../fixtures/config-docs';

const test = createIdentityTest({ env: { LOG_LEVEL: 'info', LOG_STYLE: 'raw' } });

initializeFixtures();

const MIN_VERSION = '1.6.0';
const SCHEMA_VERSION = '1.7.0';
const CLI_TIMEOUT = 25000;

let corruptNextMutatingApply = false;

function rewriteUpstreamPayload(req: http.IncomingMessage, status: number, payload: Buffer, version: string): Buffer {
	const url = req.url ?? '';
	const pathname = url.split('?')[0];

	if (pathname === '/server/info' && req.method === 'GET') {
		try {
			const parsed = JSON.parse(payload.toString('utf8'));
			if (parsed?.data?.cairncms) parsed.data.cairncms.version = version;
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

type HeldApply = { remaining: number; ms: number; runIds: string[] };

function startProxy(
	cert: Buffer,
	key: Buffer,
	upstream: string,
	options: { version?: string; applies?: string[]; hold?: HeldApply } = {}
): Promise<https.Server> {
	const target = new URL(upstream);
	const version = options.version ?? MIN_VERSION;

	const server = https.createServer({ cert, key }, (req, res) => {
		if (req.method === 'POST' && (req.url ?? '').split('?')[0] === '/config/apply') options.applies?.push(req.url!);

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
						const payload = rewriteUpstreamPayload(req, status, Buffer.concat(responseChunks), version);
						const responseHeaders = { ...upstreamRes.headers };
						delete responseHeaders['content-length'];

						const url = req.url ?? '';

						const mutatingApply =
							req.method === 'POST' && url.split('?')[0] === '/config/apply' && !url.includes('dry_run');

						const hold = options.hold;

						if (mutatingApply && hold !== undefined && hold.remaining > 0) {
							hold.remaining -= 1;
							hold.runIds.push(String(upstreamRes.headers['x-config-run-id']));

							setTimeout(() => {
								if (res.destroyed) return;
								res.writeHead(status, responseHeaders);
								res.end(payload);
							}, hold.ms).unref();

							return;
						}

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

type Document = Record<string, any>;

type RemoteHarness = { url: string; env: Record<string, string>; dir: string; applies: string[]; hold: HeldApply };

async function withRemote(
	api: Api,
	version: string,
	run: (remote: RemoteHarness) => Promise<void>,
	cleanup: () => Promise<unknown> = async () => undefined
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(api.directory, 'cairncms-remote-'));
	const applies: string[] = [];
	const hold: HeldApply = { remaining: 0, ms: 0, runIds: [] };
	let proxy: https.Server | undefined;
	let caseError: unknown;

	try {
		const { certPath, keyPath } = generateCert(dir);
		const [cert, key] = await Promise.all([fs.readFile(certPath), fs.readFile(keyPath)]);
		proxy = await startProxy(cert, key, api.url, { version, applies, hold });

		await run({
			url: `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
			env: {
				CAIRNCMS_TOKEN: common.USER.ADMIN!.TOKEN,
				LOG_LEVEL: 'info',
				LOG_STYLE: 'raw',
				NODE_EXTRA_CA_CERTS: certPath,
			},
			dir,
			applies,
			hold,
		});
	} catch (error) {
		caseError = error;
		throw error;
	} finally {
		proxy?.closeAllConnections();

		const results = await Promise.allSettled([
			cleanup(),
			new Promise<void>((resolve, reject) => {
				if (!proxy) return resolve();
				proxy.close((err) => (err ? reject(err) : resolve()));
			}),
			fs.rm(dir, { recursive: true, force: true }),
		]);

		reportCleanupFailures(
			results.filter((result): result is PromiseRejectedResult => result.status === 'rejected'),
			caseError
		);
	}
}

async function remoteCli(api: Api, remote: RemoteHarness, args: string[]) {
	const result = await runCli(api, [...args, '--url', remote.url], remote.env);
	return { status: result.status, stdout: result.stdout ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** The CLI logs raw JSON lines here, so a message with quotes is only found after decoding each line. */
function loggedMessages(output: string): string {
	return output
		.split('\n')
		.map((line) => {
			try {
				const parsed = JSON.parse(line);
				return typeof parsed?.msg === 'string' ? parsed.msg : line;
			} catch {
				return line;
			}
		})
		.join('\n');
}

async function captureTree(api: Api, remote: RemoteHarness, name = 'tree'): Promise<string> {
	const tree = path.join(remote.dir, name);
	await fs.mkdir(tree, { recursive: true });

	const capture = await remoteCli(api, remote, ['config', 'snapshot', tree, '--yes']);
	expect(capture.status, capture.output).toBe(0);

	return tree;
}

async function treeDocuments(tree: string, kind: string): Promise<Array<{ file: string; document: Document }>> {
	const directory = path.join(tree, kind);

	return Promise.all(
		(await fs.readdir(directory)).map(async (name) => ({
			file: path.join(directory, name),
			document: loadYaml(await fs.readFile(path.join(directory, name), 'utf8')) as Document,
		}))
	);
}

async function schemaFileOf(tree: string, collection: string): Promise<string> {
	const found = (await treeDocuments(tree, 'schema')).find(({ document }) => document['collection'] === collection);
	if (!found) throw new Error(`the captured tree has no schema document for ${collection}`);
	return found.file;
}

function suffix(): string {
	return randomUUID().replace(/-/g, '').slice(0, 8);
}

async function createFolder(api: Api, key: string): Promise<string> {
	const response = await adminAuth(setupRequest(api.url).post('/folders')).send({ name: key, key });
	expect(response.statusCode).toBe(200);
	return response.body.data.id;
}

async function dropCollection(api: Api, collection: string): Promise<void> {
	if (await api.database.schema.hasTable(collection)) {
		await adminAuth(setupRequest(api.url).delete(`/collections/${collection}`));
	}

	await api.database('directus_fields').where({ collection }).delete();
}

async function deleteFolders(api: Api, keys: string[]): Promise<void> {
	await api.database('directus_folders').whereIn('key', keys).whereNotNull('parent').delete();
	await api.database('directus_folders').whereIn('key', keys).delete();
}

async function deleteRole(api: Api, key: string): Promise<void> {
	const found = await findRole(api, key);
	if (found) await adminAuth(setupRequest(api.url).delete(`/roles/${found.id}`));
}

async function runRecord(api: Api, runId: string): Promise<Document> {
	return vi.waitFor(
		async () => {
			for (const line of (await api.readLogs()).split('\n')) {
				if (!line.trim().startsWith('{')) continue;

				try {
					const parsed = JSON.parse(line);
					if (parsed?.event === 'config.run.finished' && parsed?.runId === runId) return parsed as Document;
				} catch {
					continue;
				}
			}

			throw new Error(`no run record for ${runId} yet`);
		},
		{ timeout: 10_000, interval: 100 }
	);
}

async function clearCache(api: Api): Promise<void> {
	await adminAuth(setupRequest(api.url).post('/utils/cache/clear')).expect(200);
}

async function pendingFolderCollection(
	api: Api,
	remote: RemoteHarness,
	collection: string,
	folderKey: string
): Promise<string> {
	await CreateCollection(api, { collection });
	const folderId = await createFolder(api, folderKey);

	await CreateField(api, {
		collection,
		field: 'cover',
		type: 'uuid',
		meta: { interface: 'file', options: { folder: folderId } },
	});

	const tree = await captureTree(api, remote);

	await dropCollection(api, collection);
	await deleteFolders(api, [folderKey]);
	expect(await api.database.schema.hasTable(collection)).toBe(false);

	return tree;
}

async function snapshotSchemaAndFolders(api: Api): Promise<Document> {
	const response = await adminAuth(setupRequest(api.url).get('/config/snapshot')).query({
		manifest_version: '3',
		resources: 'schema,folders',
	});

	expect(response.statusCode).toBe(200);

	const snapshot = response.body.data as Document;

	const schema = sortBy((snapshot['schema'] ?? []) as Document[], 'collection').map((collection) => ({
		...collection,
		fields: sortBy((collection['fields'] ?? []) as Document[], 'field'),
		relations: sortBy((collection['relations'] ?? []) as Document[], 'field'),
	}));

	return { schema, folders: sortBy((snapshot['folders'] ?? []) as Document[], 'key') };
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

				const untrustedManifest = dumpYaml({
					version: 2,
					resources: ['roles', 'permissions', 'folders', 'settings', 'extension-settings', 'translations'],
				});

				await fs.writeFile(path.join(untrustedDir, 'cairncms-config.yaml'), untrustedManifest);

				const untrusted = await runCli(
					api,
					['config', 'snapshot', untrustedDir, '--url', proxyUrl, '--yes'],
					untrustedEnv
				);

				expect(untrusted.status).toBe(3);
				expect(`${untrusted.stdout ?? ''}${untrusted.stderr ?? ''}`).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
				expect(await fs.readFile(path.join(untrustedDir, 'cairncms-config.yaml'), 'utf8')).toBe(untrustedManifest);
				expect(await fs.readdir(untrustedDir)).toEqual(['cairncms-config.yaml']);

				const configDir = path.join(workDir!, 'config');
				await fs.mkdir(configDir, { recursive: true });

				await fs.writeFile(
					path.join(configDir, 'cairncms-config.yaml'),
					dumpYaml({
						version: 2,
						resources: ['roles', 'permissions', 'folders', 'settings', 'extension-settings', 'translations'],
					})
				);

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

		test('captures a schema-managed tree with its provenance, which local and remote dry runs then find unchanged', async ({
			api,
		}) => {
			const collection = `remote_capture_${suffix()}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					await CreateCollection(api, { collection });
					await CreateField(api, { collection, field: 'title', type: 'string' });

					const tree = await captureTree(api, remote);
					const manifest = loadYaml(await fs.readFile(path.join(tree, 'cairncms-config.yaml'), 'utf8')) as Document;

					expect(manifest['version']).toBe(3);
					expect(manifest['resources']).toContain('schema');
					expect(manifest['schema']).toEqual({ release: expect.any(String), vendor: 'postgres' });

					const captured = loadYaml(await fs.readFile(await schemaFileOf(tree, collection), 'utf8')) as Document;
					expect(captured['fields'].map((field: { field: string }) => field.field)).toContain('title');

					const local = await runCli(api, ['config', 'apply', tree, '--dry-run'], {
						LOG_LEVEL: 'info',
						LOG_STYLE: 'raw',
					});

					expect(local.status, local.stderr).toBe(0);
					expect(local.stdout + local.stderr).toContain('No changes to apply.');

					const remoteDryRun = await remoteCli(api, remote, ['config', 'apply', tree, '--dry-run']);
					expect(remoteDryRun.status, remoteDryRun.output).toBe(0);
					expect(remoteDryRun.output).toContain('No changes to apply.');
				},
				() => dropCollection(api, collection)
			);
		});

		test('previews a schema-managed tree, folder preparation included, in human and JSON form', async ({ api }) => {
			const id = suffix();
			const collection = `remote_preview_${id}`;
			const folderKey = `remote_preview_folder_${id}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					const tree = await pendingFolderCollection(api, remote, collection, folderKey);

					const human = await remoteCli(api, remote, ['config', 'apply', tree, '--dry-run']);
					expect(human.status, human.output).toBe(1);
					expect(human.output).toContain('Folder preparation');
					expect(human.output).toContain(folderKey);
					expect(human.output).toContain('Collections');
					expect(human.output).toContain(`${collection} / cover`);

					const json = await remoteCli(api, remote, ['config', 'apply', tree, '--dry-run', '--format', 'json']);
					expect(json.status, json.output).toBe(1);

					const plan = JSON.parse(json.stdout);
					expect(plan.planVersion).toBe(3);
					expect(plan.preparation).toEqual([folderKey]);

					expect(plan.changes).toContainEqual(
						expect.objectContaining({ kind: 'collections', operation: 'create', identity: { collection } })
					);

					expect(plan.changes).toContainEqual(
						expect.objectContaining({ kind: 'fields', operation: 'create', identity: { collection, field: 'cover' } })
					);

					expect(remote.applies.every((url) => url.includes('dry_run=true'))).toBe(true);
					expect(await api.database.schema.hasTable(collection)).toBe(false);
					expect(await api.database('directus_folders').where({ key: folderKey }).first()).toBeUndefined();
				},
				async () => {
					await dropCollection(api, collection);
					await deleteFolders(api, [folderKey]);
				}
			);
		});

		test('applies folders, schema, and configuration in one request, then reports no changes', async ({ api }) => {
			const id = suffix();
			const collection = `remote_apply_${id}`;
			const folderKey = `remote_apply_folder_${id}`;
			const roleKey = `remote_apply_role_${id}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					const tree = await pendingFolderCollection(api, remote, collection, folderKey);

					await fs.writeFile(
						path.join(tree, 'roles', `${roleKey}.yaml`),
						dumpYaml({ key: roleKey, name: roleKey, admin_access: false, app_access: false })
					);

					const applied = await remoteCli(api, remote, ['config', 'apply', tree, '--yes']);
					expect(applied.status, applied.output).toBe(0);
					expect(applied.output).toContain('Config applied: 1 role(s) created');
					expect(applied.output).toContain('Folder preparation: applied');
					expect(applied.output).toContain('Schema: applied');
					expect(applied.output).toContain('Configuration: applied');
					expect(applied.output).toMatch(/Run [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
					expect(remote.applies).toHaveLength(1);

					expect(await api.database('directus_folders').where({ key: folderKey }).first()).toBeDefined();
					expect(await api.database.schema.hasColumn(collection, 'cover')).toBe(true);
					expect(await findRole(api, roleKey)).toBeDefined();

					const again = await remoteCli(api, remote, ['config', 'apply', tree, '--yes']);
					expect(again.status, again.output).toBe(0);
					expect(again.output).toContain('No changes to apply.');
					expect(again.output).not.toContain('Config applied');
				},
				async () => {
					await dropCollection(api, collection);
					await deleteFolders(api, [folderKey]);
					await deleteRole(api, roleKey);
				}
			);
		});

		test('applies a schema-only change without a configuration result', async ({ api }) => {
			const collection = `remote_schema_only_${suffix()}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					await CreateCollection(api, { collection });
					const tree = await captureTree(api, remote);
					await dropCollection(api, collection);

					const applied = await remoteCli(api, remote, ['config', 'apply', tree, '--yes']);
					expect(applied.status, applied.output).toBe(0);
					expect(applied.output).toContain('Folder preparation: no changes');
					expect(applied.output).toContain('Schema: applied');
					expect(applied.output).toContain('Configuration: no changes');
					expect(applied.output).not.toContain('Config applied');
					expect(await api.database.schema.hasTable(collection)).toBe(true);
				},
				() => dropCollection(api, collection)
			);
		});

		test('carries the unconfigured table drop warning through a remote dry run', async ({ api }) => {
			const table = `remote_legacy_${suffix()}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					await api.database.schema.createTable(table, (builder) => {
						builder.increments('id');
						builder.string('title');
					});

					await api.database(table).insert({ title: 'kept' });
					await clearCache(api);

					const tree = await captureTree(api, remote);
					await fs.unlink(await schemaFileOf(tree, table));

					const message = `Deleting table "${table}" will remove its data. It has no CairnCMS collection record and may belong to another application.`;

					const human = await remoteCli(api, remote, ['config', 'apply', tree, '--dry-run']);
					expect(human.status, human.output).toBe(1);
					expect(loggedMessages(human.output)).toContain(message);

					const json = await remoteCli(api, remote, ['config', 'apply', tree, '--dry-run', '--format', 'json']);
					expect(json.status, json.output).toBe(1);

					const drops = (JSON.parse(json.stdout).warnings as Document[]).filter(
						(warning) => warning['code'] === 'UNCONFIGURED_TABLE_DROP'
					);

					expect(drops).toEqual([{ code: 'UNCONFIGURED_TABLE_DROP', kind: 'collections', collection: table, message }]);
					expect(await api.database(table).select('id', 'title')).toEqual([{ id: 1, title: 'kept' }]);
				},
				async () => {
					await api.database.schema.dropTableIfExists(table);
					await clearCache(api);
				}
			);
		});

		test('refuses a schema tree from another vendor, then applies it with --force-schema', async ({ api }) => {
			const collection = `remote_provenance_${suffix()}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					await CreateCollection(api, { collection });
					const tree = await captureTree(api, remote);
					await dropCollection(api, collection);

					const manifestPath = path.join(tree, 'cairncms-config.yaml');
					const manifest = await fs.readFile(manifestPath, 'utf8');
					await fs.writeFile(manifestPath, manifest.replace(/vendor:\s*\S+/, 'vendor: unrecognized_vendor'));

					const refused = await remoteCli(api, remote, ['config', 'apply', tree, '--yes']);
					expect(refused.status, refused.output).toBe(2);
					expect(refused.output).toContain('This schema was captured on the unrecognized_vendor database');
					expect(await api.database.schema.hasTable(collection)).toBe(false);

					const forced = await remoteCli(api, remote, ['config', 'apply', tree, '--yes', '--force-schema']);
					expect(forced.status, forced.output).toBe(0);
					expect(forced.output).toContain('Schema: applied');
					expect(await api.database.schema.hasTable(collection)).toBe(true);
				},
				() => dropCollection(api, collection)
			);
		});

		test('refuses a schema-managed tree that drops a collection and a role, or removes every administrator role', async ({
			api,
		}) => {
			const id = suffix();
			const collection = `remote_refusal_${id}`;
			const trimmed = `remote_trimmed_${id}`;
			const roleKey = `remote_refusal_role_${id}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					await CreateCollection(api, { collection });
					await CreateField(api, { collection, field: 'title', type: 'string' });
					await CreateCollection(api, { collection: trimmed });
					await CreateField(api, { collection: trimmed, field: 'extra_a', type: 'string' });
					await CreateField(api, { collection: trimmed, field: 'extra_b', type: 'string' });

					await adminAuth(setupRequest(api.url).post('/roles'))
						.send({ key: roleKey, name: roleKey, admin_access: false, app_access: false })
						.expect(200);

					const tree = await captureTree(api, remote);

					const schemaFile = await schemaFileOf(tree, collection);
					const trimmedFile = await schemaFileOf(tree, trimmed);

					const roleFile = (await treeDocuments(tree, 'roles')).find(
						({ document }) => document['key'] === roleKey
					)!.file;

					const [keptSchema, keptTrimmed, keptRole] = await Promise.all([
						fs.readFile(schemaFile, 'utf8'),
						fs.readFile(trimmedFile, 'utf8'),
						fs.readFile(roleFile, 'utf8'),
					]);

					const trimmedDocument = loadYaml(keptTrimmed) as Document;

					trimmedDocument['fields'] = (trimmedDocument['fields'] as Document[]).filter(
						(field) => !['extra_a', 'extra_b'].includes(field['field'])
					);

					await Promise.all([
						fs.unlink(schemaFile),
						fs.unlink(roleFile),
						fs.writeFile(trimmedFile, dumpYaml(trimmedDocument)),
					]);

					const destructive = await remoteCli(api, remote, ['config', 'apply', tree, '--yes']);
					const refusal = loggedMessages(destructive.output);
					expect(destructive.status, destructive.output).toBe(2);
					expect(refusal).toContain('rejected the request (400)');
					expect(refusal).toContain(`Delete ${roleKey}\n`);
					expect(refusal).toContain(`Delete schema in ${collection}\n`);
					expect(refusal).toContain(`Delete schema in ${trimmed} (2 changes)`);
					expect(refusal).not.toContain('re-snapshot');
					expect(await api.database.schema.hasTable(collection)).toBe(true);
					expect(await api.database.schema.hasColumn(trimmed, 'extra_a')).toBe(true);
					expect(await findRole(api, roleKey)).toBeDefined();

					await Promise.all([
						fs.writeFile(schemaFile, keptSchema),
						fs.writeFile(trimmedFile, keptTrimmed),
						fs.writeFile(roleFile, keptRole),
					]);

					const administrators = (await treeDocuments(tree, 'roles')).filter(
						({ document }) => document['admin_access']
					);

					expect(administrators.length).toBeGreaterThan(0);

					for (const { file } of administrators) await fs.unlink(file);

					const protectedRun = await remoteCli(api, remote, ['config', 'apply', tree, '--yes', '--destructive']);
					expect(protectedRun.status, protectedRun.output).toBe(2);
					expect(protectedRun.output).toContain('rejected the request (400)');

					for (const { document } of administrators) {
						expect(protectedRun.output).toContain(`Deletes ${document['key']}`);
						expect(await findRole(api, document['key'])).toBeDefined();
					}

					expect(await api.database.schema.hasTable(collection)).toBe(true);
				},
				async () => {
					await dropCollection(api, collection);
					await dropCollection(api, trimmed);
					await deleteRole(api, roleKey);
				}
			);
		});

		/**
		 * Captures a collection whose cover field references a folder, then removes that field and the folder from the
		 * target, so an apply of the captured tree prepares the folder before its schema step.
		 */
		async function stopScenario(api: Api, remote: RemoteHarness, collection: string, folderKey: string) {
			await CreateCollection(api, { collection });
			const folderId = await createFolder(api, folderKey);

			await CreateField(api, {
				collection,
				field: 'cover',
				type: 'uuid',
				meta: { interface: 'file', options: { folder: folderId } },
			});

			await CreateField(api, { collection, field: 'title', type: 'string' });
			await api.database(collection).insert({ title: 'kept' });

			const tree = await captureTree(api, remote);

			await adminAuth(setupRequest(api.url).delete(`/fields/${collection}/cover`)).expect(204);
			await deleteFolders(api, [folderKey]);

			const schemaFile = await schemaFileOf(tree, collection);
			const document = loadYaml(await fs.readFile(schemaFile, 'utf8')) as Document;

			return {
				tree,
				fields: document['fields'] as Document[],
				save: () => fs.writeFile(schemaFile, dumpYaml(document)),
			};
		}

		test('refuses a schema change the target cannot take before preparing folders, writing nothing', async ({
			api,
		}) => {
			const id = suffix();
			const collection = `remote_refuse_${id}`;
			const folderKey = `remote_refuse_folder_${id}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					const { tree, fields, save } = await stopScenario(api, remote, collection, folderKey);
					delete fields.find((field) => field['field'] === 'title')!['schema'];
					await save();

					for (const flags of [['--dry-run'], ['--dry-run', '--format', 'json']]) {
						const dryRun = await remoteCli(api, remote, ['config', 'apply', tree, ...flags]);
						expect(dryRun.status, dryRun.output).toBe(2);
						expect(loggedMessages(dryRun.output)).toContain('remain as a field');
					}

					const applied = await remoteCli(api, remote, ['config', 'apply', tree, '--yes']);
					const shown = loggedMessages(applied.output);

					expect(applied.status, applied.output).toBe(2);
					expect(shown).toContain('remain as a field');
					expect(shown).not.toContain('Folder preparation:');
					expect(shown).not.toContain('re-snapshot');

					expect(await api.database('directus_folders').where({ key: folderKey }).first()).toBeUndefined();
					expect(await api.database.schema.hasColumn(collection, 'cover')).toBe(false);
					expect(await api.database(collection).select('title')).toEqual([{ title: 'kept' }]);
				},
				async () => {
					await dropCollection(api, collection);
					await deleteFolders(api, [folderKey]);
				}
			);
		});

		test('reports folder preparation committed before a schema step the database refuses, and its unverified field metadata', async ({
			api,
		}) => {
			const id = suffix();
			const collection = `remote_stop_${id}`;
			const folderKey = `remote_stop_folder_${id}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					const { tree, fields, save } = await stopScenario(api, remote, collection, folderKey);

					fields.push({
						collection,
						field: 'required_no_default',
						type: 'string',
						meta: null,
						schema: {
							name: 'required_no_default',
							table: collection,
							data_type: 'varchar',
							is_nullable: false,
							default_value: null,
						},
					});

					await save();

					const applied = await remoteCli(api, remote, ['config', 'apply', tree, '--yes']);
					const shown = loggedMessages(applied.output);

					expect(applied.status, applied.output).toBe(3);
					expect(shown).toContain('Folder preparation: applied');
					expect(shown).toContain('Schema: failed');
					expect(shown).toContain('Configuration: not run');
					expect(shown).toContain('Step: Schema');
					expect(shown).toContain('re-snapshot');

					const prepared = await api.database('directus_folders').where({ key: folderKey }).first();
					expect(prepared).toBeDefined();
					expect(await api.database('directus_files').where({ folder: prepared.id }).first()).toBeUndefined();
					expect(await api.database(collection).select('title')).toEqual([{ title: 'kept' }]);
				},
				async () => {
					await dropCollection(api, collection);
					await deleteFolders(api, [folderKey]);
				}
			);
		});

		test('reports a lost apply response as an unknown outcome while the server completes the run', async ({ api }) => {
			const collection = `remote_lost_${suffix()}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					await CreateCollection(api, { collection });
					const tree = await captureTree(api, remote);
					await dropCollection(api, collection);

					remote.hold.remaining = 1;
					remote.hold.ms = 15_000;

					const lost = await runCli(api, ['config', 'apply', tree, '--yes', '--url', remote.url], {
						...remote.env,
						CAIRNCMS_REMOTE_CONFIG_TIMEOUT: '3s',
					});

					const shown = loggedMessages(`${lost.stdout ?? ''}${lost.stderr ?? ''}`);
					expect(lost.status, shown).toBe(3);
					expect(shown).toContain('Could not reach the server');
					expect(shown).toContain('re-snapshot to verify the current state');
					expect(shown).not.toContain('Schema: applied');

					await vi.waitFor(() => expect(remote.hold.runIds).toHaveLength(1), { timeout: 10_000, interval: 100 });
					const record = await runRecord(api, remote.hold.runIds[0]!);

					expect(record['result']).toBe('applied');
					expect(record['steps']).toEqual({ folders: 'skipped', schema: 'committed', configuration: 'skipped' });
					expect(record['userAgent']).toMatch(/^cairncms-cli\//);
					expect(await api.database.schema.hasTable(collection)).toBe(true);

					const check = await remoteCli(api, remote, ['config', 'apply', tree, '--dry-run']);
					expect(check.status, check.output).toBe(0);
					expect(check.output).toContain('No changes to apply.');
				},
				() => dropCollection(api, collection)
			);
		});

		test('refuses a schema-managed tree on a server below 1.7.0 before sending it, while configuration still applies', async ({
			api,
		}) => {
			await withRemote(api, MIN_VERSION, async (remote) => {
				const schemaTree = await captureTree(api, remote, 'schema-tree');

				const refused = await remoteCli(api, remote, ['config', 'apply', schemaTree, '--dry-run']);
				expect(refused.status, refused.output).toBe(2);
				expect(refused.output).toContain(`The server is version ${MIN_VERSION}`);
				expect(refused.output).toContain('requires 1.7.0 or newer');
				expect(remote.applies).toEqual([]);

				const configurationTree = path.join(remote.dir, 'configuration-tree');
				await fs.mkdir(configurationTree);

				await fs.writeFile(
					path.join(configurationTree, 'cairncms-config.yaml'),
					dumpYaml({
						version: 2,
						resources: ['roles', 'permissions', 'folders', 'settings', 'extension-settings', 'translations'],
					})
				);

				const capture = await remoteCli(api, remote, ['config', 'snapshot', configurationTree, '--yes']);
				expect(capture.status, capture.output).toBe(0);

				const configuration = await remoteCli(api, remote, ['config', 'apply', configurationTree, '--dry-run']);
				expect(configuration.status, configuration.output).toBe(0);
				expect(configuration.output).toContain('No changes to apply.');
				expect(remote.applies).toHaveLength(1);
			});
		});

		test('executes the documented capture, preview and apply workflow remotely with one mutating request', async ({
			api,
		}) => {
			await assertDocsLabAbsent(api);

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					const directory = path.join(remote.dir, 'config-demo');
					const commands: unknown[] = [];

					async function cli(args: string[], status: number) {
						const result = await remoteCli(api, remote, args);
						commands.push({ args: [...args, '--url', remote.url], ...result });
						expect(result.status, result.output).toBe(status);
						return result;
					}

					await createDocsLab(api);
					await docsManifest(directory);
					await cli(['config', 'snapshot', directory, '--yes'], 0);
					const capture = await docsSnapshot(api);
					expect((await cli(['config', 'apply', directory, '--dry-run'], 0)).output).toContain('No changes to apply.');
					await removeDocsLab(api);
					await assertDocsLabAbsent(api);
					expect((await cli(['config', 'apply', directory, '--dry-run'], 1)).output).toContain('Folder preparation');
					const json = await cli(['config', 'apply', directory, '--dry-run', '--format', 'json'], 1);
					const plan = JSON.parse(json.stdout);
					expect(plan).toMatchObject({ planVersion: 3, preparation: [DOCS_FOLDER], summary: { delete: 0 } });
					await assertDocsLabAbsent(api);
					const applied = await cli(['config', 'apply', directory, '--yes'], 0);
					expect(applied.output).toContain('Folder preparation: applied');
					expect(applied.output).toContain('Schema: applied');
					expect(applied.output).toContain('Configuration: applied');
					expect(applied.output).toContain(DOCS_ROLE);
					expect(remote.applies.filter((url) => !url.includes('dry_run=true'))).toEqual(['/config/apply']);
					await assertDocsLabRestored(api);
					expect(await docsSnapshot(api)).toEqual(capture);
					expect((await cli(['config', 'apply', directory, '--dry-run'], 0)).output).toContain('No changes to apply.');

					const empty = JSON.parse(
						(await cli(['config', 'apply', directory, '--dry-run', '--format', 'json'], 0)).stdout
					);

					expect(empty).toEqual({
						planVersion: 3,
						manifestVersion: 3,
						changes: [],
						summary: { create: 0, update: 0, delete: 0 },
						warnings: [],
						protections: [],
					});

					await recordDocsEvidence('remote-walkthrough', {
						advertisedVersion: SCHEMA_VERSION,
						capturedRelease: capture.manifest.schema.release,
						commands,
						requests: remote.applies,
						plan,
						empty,
					});
				},
				() => removeDocsLab(api)
			);
		});

		test('one remote apply reaches the same schema and folders as one local apply of the same tree', async ({
			api,
		}) => {
			const id = suffix();
			const collection = `remote_parity_${id}`;
			const folderKey = `remote_parity_folder_${id}`;

			await withRemote(
				api,
				SCHEMA_VERSION,
				async (remote) => {
					const tree = await pendingFolderCollection(api, remote, collection, folderKey);
					expect(await api.database('directus_folders').where({ key: folderKey }).first()).toBeUndefined();

					const remoteApply = await remoteCli(api, remote, ['config', 'apply', tree, '--yes']);
					expect(remoteApply.status, remoteApply.output).toBe(0);
					const remoteState = await snapshotSchemaAndFolders(api);

					await dropCollection(api, collection);
					await deleteFolders(api, [folderKey]);
					expect(await api.database.schema.hasTable(collection)).toBe(false);
					expect(await api.database('directus_folders').where({ key: folderKey }).first()).toBeUndefined();

					const localApply = await runCli(api, ['config', 'apply', tree, '--yes'], {
						LOG_LEVEL: 'info',
						LOG_STYLE: 'raw',
					});

					expect(localApply.status, localApply.stderr).toBe(0);

					expect(await snapshotSchemaAndFolders(api)).toEqual(remoteState);
					expect(await api.database.schema.hasColumn(collection, 'cover')).toBe(true);
				},
				async () => {
					await dropCollection(api, collection);
					await deleteFolders(api, [folderKey]);
				}
			);
		});
	}
);

function reportCleanupFailures(failures: PromiseRejectedResult[], caseError: unknown) {
	if (failures.length)
		throw new AggregateError(
			[...(caseError === undefined ? [] : [caseError]), ...failures.map((failure) => failure.reason)],
			'Configuration CLI scenario cleanup failed'
		);
}
