import type { Api } from '../fixtures/environment';
import { CreateCollection, CreateField, CreateFieldM2O, CreateFieldO2M, CreateItem, USER } from '../fixtures/data';
import { ROLE } from './functions';
import request from '../fixtures/request';

export const collectionName = 'common_test_collection';
export const collectionNameM2O = 'common_test_collection_m2o';
export const collectionNameO2M = 'common_test_collection_o2m';

export async function resetCommon(api: Api) {
	for (const collection of [collectionNameO2M, collectionName, collectionNameM2O]) {
		if (await api.database.schema.hasTable(collection)) {
			await request(api.url)
				.delete('/collections/' + collection)
				.auth(api.adminToken, { type: 'bearer' })
				.expect(204);
		}
	}

	// The bootstrap administrator is not one of the subjects under test.
	await api
		.database('directus_users')
		.whereIn(
			'email',
			Object.values(USER).map((user) => user.EMAIL)
		)
		.delete();

	await api
		.database('directus_roles')
		.whereIn(
			'name',
			Object.values(ROLE).map((role) => role.NAME)
		)
		.delete();
}

export async function prepareSchema(api: Api) {
	for (const collection of [collectionName, collectionNameM2O, collectionNameO2M])
		await CreateCollection(api, { collection });
	await CreateField(api, { collection: collectionName, field: 'sample_field', type: 'string' });

	await CreateFieldM2O(api, {
		collection: collectionName,
		field: 'm2o_field',
		otherCollection: collectionNameM2O,
		primaryKeyType: 'integer',
	});

	await CreateFieldO2M(api, {
		collection: collectionName,
		field: 'o2m_field',
		otherCollection: collectionNameO2M,
		otherField: 'm2o_field',
		primaryKeyType: 'integer',
	});
}

export async function prepareItems(api: Api) {
	for (const item of [
		{ sample_field: 'sample_value' },
		{ sample_field: 'sample_value', m2o_field: {} },
		{ sample_field: 'sample_value', o2m_field: { create: [{}], update: [], delete: [] } },
	])
		await CreateItem(api, { collection: collectionName, item });
}

export async function removePreviousFields(api: Api, count: number) {
	for (const [collection, field] of [
		[collectionName, 'o2m_field'],
		[collectionNameO2M, 'm2o_field'],
		[collectionName, 'm2o_field'],
		[collectionName, 'sample_field'],
	].slice(0, count)) {
		await request(api.url)
			.delete('/fields/' + collection + '/' + field)
			.auth(api.adminToken, { type: 'bearer' })
			.expect(204);
	}
}
