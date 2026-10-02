/* eslint-disable no-console, no-empty-pattern */
import { test as base } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CreateUser } from '../../common/functions';
import type { Api } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const test = base.extend<{ state: Prerequisite<void>; ready: void }>({
	state: [
		async ({}, use) => {
			const secret = 'report-fixture-token-67241';

			const server = createServer((request, response) => {
				request.resume();
				response.writeHead(400, { 'content-type': 'application/json' });

				response.end(
					JSON.stringify({
						errors: [{ message: `SETUP_ERROR_CONTEXT ${secret}`, extensions: { code: 'INVALID_PAYLOAD' } }],
					})
				);
			});

			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing HTTP control address');

			try {
				await capturePrerequisite<void>(
					async (ready) => {
						await CreateUser({ url: `http://127.0.0.1:${address.port}`, adminToken: secret } as Api, {
							email: 'fixture@example.test',
							token: secret,
							password: secret,
						});

						await ready();
					},
					use,
					[]
				);
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
		{ scope: 'file' },
	],
	ready: [
		async ({ state, task, skip }, use) => {
			requirePrerequisite(state, 'user setup', { task, skip });
			await use();
		},
		{ auto: true },
	],
});

for (let index = 0; index < 2; index++)
	test(`dependent setup body ${index}`, () => console.log('UNEXPECTED_DEPENDENT_BODY'));
