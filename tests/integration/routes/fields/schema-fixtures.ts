import { setupRequest } from '../../fixtures/request';
import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { PRIMARY_KEY_TYPES, TEST_USERS, USER, type PrimaryKeyType } from '../../fixtures/identities';
import { CreateCollection } from '../../fixtures/schema';
import { createScenarioTest } from '../../fixtures/scenario';
import { prepareListingTables, clearListingTables } from '../collections/schema-fixtures';
export { DEFAULT_DB_TABLES } from '../collections/schema-fixtures';

export const createFieldsTest = (hooks = false) =>
	createScenarioTest({
		environment: { env: { CACHE_SCHEMA: 'false' }, hookFixtures: hooks ? ['action-verify-schema'] : [] },
		prepare: async (api) => {
			await prepareListingTables(api);

			for (const primaryKeyType of PRIMARY_KEY_TYPES) {
				await CreateCollection(api, { collection: `test_fields_crud_${primaryKeyType}`, primaryKeyType });
			}
		},
		cleanup: async (api) => {
			for (const pkType of PRIMARY_KEY_TYPES) {
				const collection = `test_fields_crud_${pkType}`;
				await api.database.schema.dropTableIfExists(collection);
				await api.database('directus_fields').where({ collection }).delete();
				await api.database('directus_collections').where({ collection }).delete();
			}

			await clearListingTables(api);
		},
	});
export const fieldsTest = createFieldsTest();

// Reset through SQL so setup does not emit schema-action events.
export async function resetFields(api: Api, pkType: PrimaryKeyType, existing: boolean) {
	const collection = `test_fields_crud_${pkType}`;

	if (await api.database.schema.hasColumn(collection, 'test_field')) {
		await api.database.schema.alterTable(collection, (table) => {
			table.dropColumn('test_field');
		});
	}

	await api
		.database('directus_fields')
		.where({ collection })
		.whereIn('field', ['test_field', 'test_alias_field'])
		.delete();

	if (existing) {
		await api.database.schema.alterTable(collection, (table) => {
			table.string('test_field');
		});

		await api.database('directus_fields').insert([
			{ collection, field: 'test_field', interface: null, special: null, note: null },
			{ collection, field: 'test_alias_field', interface: 'group-raw', special: 'alias,no-data,group', note: null },
		]);
	}
}

export async function seedFieldSchemaEvents(api: Api, pkType: PrimaryKeyType) {
	await resetFields(api, pkType, false);
	const collection = `test_fields_crud_${pkType}`;
	const normal = { collection, field: 'test_field', meta: {}, schema: {}, type: 'string' };

	const alias = {
		collection,
		field: 'test_alias_field',
		meta: { interface: 'group-raw', special: ['alias', 'no-data', 'group'] },
		type: 'alias',
	};

	for (const key of TEST_USERS) {
		await setupRequest(api.url)
			.post(`/fields/${collection}`)
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.send(normal)
			.expect(key === 'ADMIN' ? 200 : 403);

		if (await api.database.schema.hasColumn(collection, 'test_field')) {
			await api.database.schema.alterTable(collection, (table) => {
				table.dropColumn('test_field');
			});
		}
	}

	for (const key of TEST_USERS) {
		await setupRequest(api.url)
			.post(`/fields/${collection}`)
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.send(alias)
			.expect(key === 'ADMIN' ? 200 : 403);
	}

	await api.database.schema.alterTable(collection, (table) => {
		table.string('test_field');
	});

	for (const field of ['test_field', 'test_alias_field']) {
		for (const key of TEST_USERS) {
			await setupRequest(api.url)
				.patch(`/fields/${collection}/${field}`)
				.auth(USER[key]!.TOKEN, { type: 'bearer' })
				.send({ collection, field, meta: { note: 'updated-note' } })
				.expect(key === 'ADMIN' ? 200 : 403);

			await api
				.database('directus_fields')
				.where({ collection })
				.whereIn('field', ['test_field', 'test_alias_field'])
				.update({ note: null });
		}
	}

	for (const key of TEST_USERS) {
		await setupRequest(api.url)
			.patch(`/fields/${collection}`)
			.auth(USER[key]!.TOKEN, { type: 'bearer' })
			.send(['test_field', 'test_alias_field'].map((field) => ({ collection, field, meta: { note: 'updated-note' } })))
			.expect(key === 'ADMIN' ? 200 : 403);

		await api
			.database('directus_fields')
			.where({ collection })
			.whereIn('field', ['test_field', 'test_alias_field'])
			.update({ note: null });
	}

	for (const field of ['test_field', 'test_alias_field']) {
		for (const key of TEST_USERS) {
			await setupRequest(api.url)
				.delete(`/fields/${collection}/${field}`)
				.auth(USER[key]!.TOKEN, { type: 'bearer' })
				.expect(key === 'ADMIN' ? 204 : 403);

			await setupRequest(api.url)
				.get(`/fields/${collection}/${field}`)
				.auth(USER[key]!.TOKEN, { type: 'bearer' })
				.expect(403);

			if (!(await api.database.schema.hasColumn(collection, 'test_field'))) {
				await api.database.schema.alterTable(collection, (table) => {
					table.string('test_field');
				});
			}
		}
	}

	await expect
		.poll(() => api.database('tests_extensions_log').where('key', 'like', `action-verify-schema/${collection}%`), {
			timeout: 10_000,
		})
		.toHaveLength(4);
}
