import { setupRequest } from '../../fixtures/request';
import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { PRIMARY_KEY_TYPES, TEST_USERS, USER, type PrimaryKeyType } from '../../fixtures/identities';
import { createScenarioTest } from '../../fixtures/scenario';

export const DEFAULT_DB_TABLES = [
	'tests_flow_data',
	'tests_flow_completed',
	'directus_activity',
	'directus_collections',
	'directus_dashboards',
	'directus_fields',
	'directus_files',
	'directus_folders',
	'directus_migrations',
	'directus_notifications',
	'directus_panels',
	'directus_permissions',
	'directus_presets',
	'directus_relations',
	'directus_revisions',
	'directus_roles',
	'directus_sessions',
	'directus_settings',
	'directus_shares',
	'directus_users',
];

export const collectionListingTest = createScenarioTest({
	environment: { env: { CACHE_SCHEMA: 'false' } },
	prepare: prepareListingTables,
	cleanup: async (api) => {
		for (const pkType of PRIMARY_KEY_TYPES) await clearCollectionFixtures(api, pkType);
		await clearListingTables(api);
	},
});

async function removeCollections(api: Api, names: string[]) {
	for (const collection of names) {
		await api.database.schema.dropTableIfExists(collection);
		await api.database('directus_fields').where({ collection }).delete();
		await api.database('directus_collections').where({ collection }).delete();
	}
}

export async function clearCollectionFixtures(api: Api, pkType: PrimaryKeyType) {
	await removeCollections(api, [
		`test_collections_crud_creation_${pkType}`,
		`test_collections_crud_folder_${pkType}`,
		`test_collections_crud_batch_update_${pkType}`,
		`test_collections_crud_batch_update2_${pkType}`,
		`test_collections_crud_batch_update3_${pkType}`,
	]);
}

// Use SQL cleanup so only the requested API mutations emit schema-action events.
export async function seedCollectionSchemaEvents(api: Api, pkType: PrimaryKeyType) {
	await clearCollectionFixtures(api, pkType);
	const regular = `test_collections_crud_creation_${pkType}`;
	const folder = `test_collections_crud_folder_${pkType}`;

	const batch = [
		`test_collections_crud_batch_update_${pkType}`,
		`test_collections_crud_batch_update2_${pkType}`,
		`test_collections_crud_batch_update3_${pkType}`,
	];

	const ids = {
		uuid: {
			field: 'id',
			type: 'uuid',
			meta: { hidden: true, readonly: true, interface: 'input', special: ['uuid'] },
			schema: { is_primary_key: true, length: 36, has_auto_increment: false },
		},
		string: {
			field: 'id',
			type: 'string',
			meta: { hidden: false, readonly: false, interface: 'input' },
			schema: { is_primary_key: true, length: 255, has_auto_increment: false },
		},
		integer: {
			field: 'id',
			type: 'integer',
			meta: { hidden: true, interface: 'input', readonly: true },
			schema: { is_primary_key: true, has_auto_increment: true },
		},
	};

	const id = ids[pkType];

	for (const key of TEST_USERS) {
		await setupRequest(api.url)
			.post('/collections')
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.send({ collection: regular, meta: {}, schema: {}, fields: [id] })
			.expect(key === 'ADMIN' ? 200 : 403);

		await removeCollections(api, [regular]);
	}

	for (const key of TEST_USERS) {
		await setupRequest(api.url)
			.post('/collections')
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.send({ collection: folder, meta: {}, schema: null })
			.expect(key === 'ADMIN' ? 200 : 403);
	}

	for (const key of TEST_USERS) {
		await setupRequest(api.url)
			.post('/collections')
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.send(batch.map((collection) => ({ collection, meta: {}, schema: {} })))
			.expect(key === 'ADMIN' ? 200 : 403);

		const sorts = [3, 1, 2];

		await setupRequest(api.url)
			.patch('/collections')
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.send(
				batch.map((collection, index) => ({ collection, meta: { sort: sorts[index], note: String(sorts[index]) } }))
			)
			.expect(key === 'ADMIN' ? 200 : 403);

		await removeCollections(api, batch);
	}

	for (const key of TEST_USERS) {
		await setupRequest(api.url)
			.post('/collections')
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.send({ collection: regular, meta: {}, schema: {} })
			.expect(key === 'ADMIN' ? 200 : 403);

		await setupRequest(api.url)
			.delete(`/collections/${regular}`)
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.expect(key === 'ADMIN' ? 204 : 403);

		await removeCollections(api, [regular]);
	}

	for (const key of TEST_USERS) {
		// The existing folder makes this create a duplicate before the delete probe.
		await setupRequest(api.url)
			.post('/collections')
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.send({ collection: folder, meta: {}, schema: null })
			.expect(key === 'ADMIN' ? 400 : 403);

		await setupRequest(api.url)
			.delete(`/collections/${folder}`)
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.expect(key === 'ADMIN' ? 204 : 403);
	}

	await expect
		.poll(
			() =>
				api
					.database('tests_extensions_log')
					.where('key', 'like', `action-verify-schema/test_collections_crud%${pkType}%`),
			{ timeout: 10_000 }
		)
		.toHaveLength(10);
}

export async function prepareListingTables(api: Api) {
	await api.database.schema.createTable('tests_flow_data', (table) => {
		table.increments('id').primary();
		table.string('total_tests_count');
	});

	await api.database.schema.createTable('tests_flow_completed', (table) => {
		table.increments('id').primary();
		table.string('test_file_path');
	});
}

export async function clearListingTables(api: Api) {
	await api.database.schema.dropTableIfExists('tests_flow_completed');
	await api.database.schema.dropTableIfExists('tests_flow_data');
}
