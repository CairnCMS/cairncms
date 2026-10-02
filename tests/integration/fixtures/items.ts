import { expect } from 'vitest';
import { createIdentityTest, PRIMARY_KEY_TYPES, type PrimaryKeyType, USER } from './identities';
import { setupRequest as request, setupGraphQL as requestGraphQL } from './request';
import type { Api } from './environment';
import { randomUUID } from 'node:crypto';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';

export const collectionArtists = 'test_items_no_relations_artists';
export const itemsTest = createIdentityTest(true).extend<{
	schemaState: Prerequisite<string[]>;
	schema: string[];
	clean: void;
}>({
	schemaState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;
			const identities = identityState.value;

			await capturePrerequisite<string[]>(
				async (ready) => {
					const started = performance.now();
					const collections = [];

					for (const type of PRIMARY_KEY_TYPES) {
						const collection = `${collectionArtists}_${type}`;

						const id = {
							field: 'id',
							type,
							meta: {
								interface: 'input',
								hidden: type !== 'string',
								readonly: type !== 'string',
								...(type === 'uuid' ? { special: ['uuid'] } : {}),
							},
							schema: {
								is_primary_key: true,
								has_auto_increment: type === 'integer',
								...(type !== 'integer' ? { length: type === 'uuid' ? 36 : 255 } : {}),
							},
						};

						await request(api.url)
							.post('/collections')
							.auth(identities.ADMIN!.TOKEN, { type: 'bearer' })
							.send({
								collection,
								meta: {},
								schema: {},
								fields: [id, ...['name', 'company'].map((field) => ({ field, type: 'string', meta: {}, schema: {} }))],
							})
							.expect(200);

						collections.push(collection);
					}

					api.recordTiming('collection-schema', started);
					await ready(collections);
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	schema: async ({ api, identities, schemaState, task, skip }, use) => {
		void api;
		void identities;
		await use(requirePrerequisite(schemaState, 'collection schema', { task, skip }));
	},
	clean: [
		async ({ api, schema }, use) => {
			for (const collection of schema) await api.database(collection).delete();
			await api.database('tests_extensions_log').delete();
			await use();

			// Action hooks finish asynchronously. Drain this case's observable writes before the next reset.
			let events = 0;

			for (const collection of schema) {
				const rows = await api.database(collection).where('name', 'like', 'one-%').orWhere('name', 'like', 'many-%');
				events += rows.length;
			}

			if (events)
				await expect
					.poll(
						async () => {
							const rows = await api.database('tests_extensions_log');
							return rows.length;
						},
						{ timeout: 10_000 }
					)
					.toBe(events);
		},
		{ auto: true },
	],
});

export async function seedHookEvents(api: Api, pkType: PrimaryKeyType, kind: 'one' | 'many') {
	const collection = `${collectionArtists}_${pkType}`;
	const artist = () => ({ name: `${kind}-${randomUUID()}`, ...(pkType === 'string' ? { id: randomUUID() } : {}) });
	const data = () => (kind === 'one' ? artist() : Array.from({ length: 5 }, artist));

	await request(api.url)
		.post(`/items/${collection}`)
		.auth(USER.ADMIN!.TOKEN, { type: 'bearer' })
		.send(data())
		.expect(200);

	const key = `create_${collection}_${kind === 'one' ? 'item' : 'items'}`;

	const response = await requestGraphQL(api.url, false, USER.ADMIN!.TOKEN, {
		mutation: { [key]: { __args: { data: data() }, id: true } },
	});

	expect(response.statusCode).toBe(200);
	expect(response.body.errors).toBeUndefined();

	await expect
		.poll(
			async () => {
				const rows = await api
					.database('tests_extensions_log')
					.where('key', 'like', `action-verify-create/${collection}/${kind}%`);

				return rows.length;
			},
			{ timeout: 10_000 }
		)
		.toBe(kind === 'one' ? 2 : 10);
}
