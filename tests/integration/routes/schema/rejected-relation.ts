import type { Api } from '../../fixtures/environment';
import { CreateField, type OptionsCreateFieldM2O } from '../../fixtures/schema';
import request from './roundtrip-request';

// This target lacks its PK suffix and does not exist. Keep the integer column
// with m2o metadata after relation creation fails; the snapshot must remove it
// while preserving the valid M2O/O2M links.
export async function createRejectedM2O(api: Api, options: OptionsCreateFieldM2O) {
	await CreateField(api, {
		collection: options.collection,
		field: options.field,
		type: 'integer',
		meta: { special: ['m2o'] },
		schema: {},
	});

	await request(api.url)
		.get(`/relations/${options.collection}/${options.field}`)
		.auth(api.adminToken, { type: 'bearer' });

	await request(api.url)
		.post('/relations')
		.auth(api.adminToken, { type: 'bearer' })
		.send({
			collection: options.collection,
			field: options.field,
			meta: {},
			schema: { on_delete: 'SET NULL' },
			related_collection: options.otherCollection,
		})
		.expect(400);
}
