/* eslint-disable no-console, no-empty-pattern */
import { test, expect } from 'vitest';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const failure = process.env.CONTROL_PREREQUISITE;

const fixture = test.extend<{
	apiState: Prerequisite<string>;
	identityState: Prerequisite<string>;
	schemaState: Prerequisite<string>;
	api: string;
	identities: string;
	schema: string;
}>({
	apiState: [
		async ({}, use) => {
			await capturePrerequisite<string>(async (ready) => {
				console.log('ATTEMPT_API');
				if (failure === 'api') throw new Error('CONTROL_PREREQUISITE_FAILURE');
				await ready('api');
			}, use);
		},
		{ scope: 'file' },
	],
	identityState: [
		async ({ apiState }, use) => {
			if (!apiState.ok) return use(apiState);

			await capturePrerequisite<string>(async (ready) => {
				console.log('ATTEMPT_IDENTITIES');
				if (failure === 'identities') throw new Error('CONTROL_PREREQUISITE_FAILURE');
				await ready('identities');
			}, use);
		},
		{ scope: 'file' },
	],
	schemaState: [
		async ({ identityState }, use) => {
			if (!identityState.ok) return use(identityState);

			await capturePrerequisite<string>(async (ready) => {
				console.log('ATTEMPT_SCHEMA');
				if (failure === 'schema') throw new Error('CONTROL_PREREQUISITE_FAILURE');
				await ready('schema');
			}, use);
		},
		{ scope: 'file' },
	],
	api: async ({ apiState, task, skip }, use) => {
		await use(requirePrerequisite(apiState, 'api', { task, skip }));
	},
	identities: async ({ api, identityState, task, skip }, use) => {
		void api;
		await use(requirePrerequisite(identityState, 'identities', { task, skip }));
	},
	schema: async ({ identities, schemaState, task, skip }, use) => {
		void identities;
		await use(requirePrerequisite(schemaState, 'schema', { task, skip }));
	},
});

for (let index = 0; index < 3; index++) {
	fixture(`dependent ${index}`, ({ schema }) => {
		console.log('DEPENDENT_BODY');
		expect(schema).toBe('schema');
	});
}

test('independent test still runs', () => {
	console.log('INDEPENDENT_BODY');
	expect(true).toBe(true);
});

const independent = test.extend<{ state: Prerequisite<string>; value: string }>({
	state: [
		async ({}, use) => {
			await capturePrerequisite<string>(async () => {
				throw new Error('CONTROL_PREREQUISITE_FAILURE');
			}, use);
		},
		{ scope: 'file' },
	],
	value: async ({ state, task, skip }, use) => {
		await use(requirePrerequisite(state, 'independent fixture with equal error text', { task, skip }));
	},
});

independent('equal error text remains an independent failure', ({ value }) => {
	throw new Error(`INDEPENDENT_DEPENDENT_BODY: ${value}`);
});
