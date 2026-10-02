import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createStorageTest } from '../../fixtures/storage';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
export type ImportFixture = {
	url: string;
	fixtureOrigin: string;
	readonly fixtureRequests: number;
	readonly deniedRequests: number;
};

const DENIED_HOST = '127.0.0.2';

function createFixtureServer(imageBytes: Buffer, onRequest: () => void, redirectTarget: string) {
	return http.createServer((req, res) => {
		onRequest();

		if (req.url === '/note.txt') {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end('plain text, not an image');
			return;
		}

		if (req.url === '/big.png') {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end(Buffer.alloc(2 * 1024 * 1024, 0x61));
			return;
		}

		if (req.url === '/redirect') {
			res.writeHead(302, { location: redirectTarget });
			res.end();
			return;
		}

		if (req.url === '/truncate') {
			res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(4 * 1024 * 1024) });
			// Abort after sending data so the failure occurs during the download.
			res.write(Buffer.alloc(1024, 0x61), () => res.destroy());
			return;
		}

		res.writeHead(200, { 'content-type': 'image/png' });
		res.end(imageBytes);
	});
}

function createCountingServer(imageBytes: Buffer, onRequest: () => void) {
	return http.createServer((req, res) => {
		onRequest();
		res.writeHead(200, { 'content-type': 'image/png' });
		res.end(imageBytes);
	});
}

async function listen(server: http.Server, host: string) {
	await new Promise<void>((resolve, reject) => {
		const failed = (error: Error) => reject(error);
		server.once('error', failed);

		server.listen(0, host, () => {
			server.removeListener('error', failed);
			resolve();
		});
	});

	return 'http://' + host + ':' + (server.address() as AddressInfo).port;
}

async function close(server: http.Server | undefined) {
	if (!server?.listening) return;
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export function createImportTest(imagePath: string) {
	return createStorageTest().extend<{ importState: Prerequisite<ImportFixture>; imports: ImportFixture }>({
		importState: [
			async ({ apiState, teardownFailures }, use) => {
				if (!apiState.ok) return use(apiState);
				const api = apiState.value;

				await capturePrerequisite<ImportFixture>(
					async (ready) => {
						const bytes = readFileSync(imagePath);

						let fixtureRequests = 0,
							deniedRequests = 0;

						const denied = createCountingServer(bytes, () => {
							deniedRequests++;
						});

						let fixture: http.Server | undefined;

						try {
							const deniedOrigin = await listen(denied, DENIED_HOST);

							fixture = createFixtureServer(
								bytes,
								() => {
									fixtureRequests++;
								},
								deniedOrigin + '/blocked.png'
							);

							const fixtureOrigin = await listen(fixture, '127.0.0.1');

							const importer = await api.start({
								IMPORT_IP_DENY_LIST: DENIED_HOST,
								FILES_MIME_TYPE_ALLOW_LIST: 'image/png',
								FILES_MAX_UPLOAD_SIZE: '1mb',
							});

							await ready({
								url: importer.url,
								fixtureOrigin,
								get fixtureRequests() {
									return fixtureRequests;
								},
								get deniedRequests() {
									return deniedRequests;
								},
							});
						} finally {
							for (const server of [fixture, denied]) {
								try {
									await close(server);
								} catch (error) {
									teardownFailures.push(error);
								}
							}
						}
					},
					use,
					teardownFailures
				);
			},
			{ scope: 'file' },
		],
		imports: [
			async ({ api, storage, importState, task, skip }, use) => {
				void api;
				void storage;
				await use(requirePrerequisite(importState, 'file-import HTTP fixtures', { task, skip }));
			},
			{ auto: true },
		],
	});
}
