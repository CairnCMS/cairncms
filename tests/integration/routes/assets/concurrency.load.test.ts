import { describe, expect, inject } from 'vitest';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import { createStorageTest } from '../../fixtures/storage';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { assertSuccessfulLoad } from '../../harness/load-result.mjs';

initializeFixtures();

const test = createStorageTest();
const autocannon = createRequire(import.meta.url).resolve('autocannon/autocannon.js');
const imageFilePath = fileURLToPath(new URL('../../../blackbox/assets/layers.png', import.meta.url));

describe('/assets', () => {
	describe('GET /assets/:id', () => {
		describe('Concurrent file requests', () => {
			describe.each(['local', 's3'])('Storage: %s', (storage) => {
				test('REST', async ({ api }) => {
					const spawnCountTarget = 5;
					let loadError: unknown;
					const outcomes: Awaited<ReturnType<typeof api.startNode>['result']>[] = [];

					const insertResponse = await request(api.url)
						.post('/files')
						.set('Authorization', `Bearer ${api.adminToken}`)
						.field('storage', storage)
						.attach('file', createReadStream(imageFilePath));

					expect(insertResponse.statusCode).toBe(200);
					const url = `${api.url}/assets/${insertResponse.body.data.id}?access_token=${api.adminToken}`;

					// Use autocannon's default duration and client timeout for each burst.
					const run = (async () => {
						try {
							for (let count = 0; count < spawnCountTarget; count++) {
								const load = api.startNode(autocannon, ['--json', '-c', '100', url], { timeoutMs: 600_000 });
								load.child.stdin!.end();
								const result = await load.result;
								outcomes.push(result);
								assertSuccessfulLoad(result);
							}
						} catch (error) {
							loadError = error;
						}
					})();

					await run;

					await writeFile(
						join(inject('integration').directory, `${basename(api.directory)}-autocannon-${storage}.json`),
						JSON.stringify(outcomes, null, 2)
					);

					if (loadError) throw loadError;
				}, 600000);
			});
		});
	});
});
