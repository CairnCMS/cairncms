/* eslint-disable no-console */
import { expect } from 'vitest';
import { createApiTest } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateUser } from '../../common/functions';
import request from '../../fixtures/request';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();
const mode = process.env['CONTROL_FIXTURE_FAILURE'];

const test = createApiTest().extend<{ state: Prerequisite<void>; ready: void }>({
	state: [
		async ({ apiState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					try {
						if (mode === 'identity')
							await CreateUser(api, { token: 'invalid-fixture-user', email: 'bootstrap@example.com' });
						if (mode === 'setup') throw new Error('CONTROL_PRIMARY_SETUP');
						await ready();
					} finally {
						if (mode !== 'identity') {
							try {
								await request(api.url)
									.delete('/flows/11111111-1111-4111-8111-111111111111')
									.auth('intentionally-invalid-cleanup-token', { type: 'bearer' })
									.expect(204);
							} catch (error) {
								teardownFailures.push(new Error('CONTROL_CLEANUP_FAILURE', { cause: error }));
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
	ready: [
		async ({ api, state, task, skip }, use) => {
			void api;
			requirePrerequisite(state, 'identity and scenario prerequisite', { task, skip });
			await use();
		},
		{ auto: true },
	],
});

for (let index = 0; index < 2; index++)
	test(`dependent body ${index}`, () => {
		console.log('CONTROL_DEPENDENT_BODY');
		if (mode === 'body') throw new Error('CONTROL_PRIMARY_BODY');
		expect(true).toBe(true);
	});
