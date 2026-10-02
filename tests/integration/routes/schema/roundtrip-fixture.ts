import { setupRequest } from './roundtrip-request';
import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest, PRIMARY_KEY_TYPES } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { prepareBackground } from './roundtrip-background';
import { seedDBStructure, deleteAllCollections } from './schema.seed';

type Roundtrip = {
	vendor: string;
	original: any;
	empty: any;
	yaml: string;
	uncached: Awaited<ReturnType<Api['start']>>;
};
export type SchemaContext = { api: Api; roundtrip: Roundtrip };

export async function restoreSnapshot(api: Api, snapshot: any) {
	const diff = await setupRequest(api.url).post('/schema/diff').auth(api.adminToken, { type: 'bearer' }).send(snapshot);
	if (diff.statusCode === 204) return;
	expect(diff.statusCode).toBe(200);

	await setupRequest(api.url)
		.post('/schema/apply')
		.auth(api.adminToken, { type: 'bearer' })
		.send(diff.body.data)
		.expect(204);
}

export async function applyYamlSnapshot(api: Api, yaml: string) {
	const diff = await setupRequest(api.url)
		.post('/schema/diff')
		.auth(api.adminToken, { type: 'bearer' })
		.attach('file', Buffer.from(yaml))
		.expect(200);

	await setupRequest(api.url)
		.post('/schema/apply')
		.auth(api.adminToken, { type: 'bearer' })
		.attach('file', Buffer.from(JSON.stringify(diff.body.data)))
		.expect(204);
}

export const schemaTest = createIdentityTest().extend<{
	roundtripState: Prerequisite<Roundtrip>;
	roundtrip: Roundtrip;
}>({
	roundtripState: [
		async ({ apiState, identityState, vendor, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<Roundtrip>(
				async (ready) => {
					const uncached = await api.start({ CACHE_SCHEMA: 'false' });
					const seedApi = { ...api, url: uncached.url };
					await prepareBackground(seedApi, vendor);
					await seedDBStructure(seedApi, vendor);
					// Refresh the main API's schema cache after seeding through the uncached companion.
					const clear = await setupRequest(api.url).post('/utils/cache/clear').auth(api.adminToken, { type: 'bearer' });
					const fields = await setupRequest(api.url).get('/fields').auth(api.adminToken, { type: 'bearer' });
					expect(clear.statusCode).toBe(200);
					expect(fields.statusCode).toBe(200);

					const full = await setupRequest(uncached.url)
						.get('/schema/snapshot')
						.auth(api.adminToken, { type: 'bearer' })
						.expect(200);

					const yaml = await setupRequest(uncached.url)
						.get('/schema/snapshot')
						.query({ export: 'yaml' })
						.auth(api.adminToken, { type: 'bearer' })
						.expect(200);

					for (const pkType of PRIMARY_KEY_TYPES)
						for (const defaults of [false, true]) await deleteAllCollections(seedApi, pkType, defaults);

					const empty = await setupRequest(uncached.url)
						.get('/schema/snapshot')
						.auth(api.adminToken, { type: 'bearer' })
						.expect(200);

					expect(full.body.data.collections.length - empty.body.data.collections.length).toBe(90);
					await ready({ vendor, original: full.body.data, yaml: yaml.text, empty: empty.body.data, uncached });
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	roundtrip: async ({ api, identities, roundtripState, task, skip }, use) => {
		void api;
		void identities;
		await use(requirePrerequisite(roundtripState, 'full schema round-trip inputs', { task, skip }));
	},
});
