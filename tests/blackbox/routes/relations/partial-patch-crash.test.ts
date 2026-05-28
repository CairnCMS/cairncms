import { getUrl } from '@common/config';
import { CreateCollection, CreateFieldM2O, DeleteCollection } from '@common/functions';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import request from 'supertest';

const PARENT_COLLECTION = 'test_relations_partial_patch_parent';
const CHILD_COLLECTION = 'test_relations_partial_patch_child';
const FK_FIELD = 'parent';

describe(`/relations PATCH partial body`, () => {
	beforeAll(async () => {
		for (const vendor of vendors) {
			await DeleteCollection(vendor, { collection: CHILD_COLLECTION });
			await DeleteCollection(vendor, { collection: PARENT_COLLECTION });

			await CreateCollection(vendor, { collection: PARENT_COLLECTION });
			await CreateCollection(vendor, { collection: CHILD_COLLECTION });

			await CreateFieldM2O(vendor, {
				collection: CHILD_COLLECTION,
				field: FK_FIELD,
				otherCollection: PARENT_COLLECTION,
			});
		}
	}, 300000);

	afterAll(async () => {
		for (const vendor of vendors) {
			await DeleteCollection(vendor, { collection: CHILD_COLLECTION });
			await DeleteCollection(vendor, { collection: PARENT_COLLECTION });
		}
	}, 300000);

	describe('PATCH /relations/:collection/:field with a partial body succeeds and the API process stays alive', () => {
		it.each(vendors)('%s', async (vendor) => {
			const alias = 'children_via_partial_patch';

			const response = await request(getUrl(vendor))
				.patch(`/relations/${CHILD_COLLECTION}/${FK_FIELD}`)
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
				.send({ meta: { one_field: alias } });

			expect(response.statusCode).toBe(200);
			expect(response.body.data.meta.one_field).toBe(alias);
			expect(response.body.data.schema.on_delete).toBe('SET NULL');

			const ping = await request(getUrl(vendor)).get('/server/ping');

			expect(ping.statusCode).toBe(200);
			expect(ping.text).toBe('pong');
		});
	});

	describe('PATCH /relations/:collection/:field with a full body still succeeds (regression)', () => {
		it.each(vendors)('%s', async (vendor) => {
			const alias = 'children_via_full_patch';

			const response = await request(getUrl(vendor))
				.patch(`/relations/${CHILD_COLLECTION}/${FK_FIELD}`)
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
				.send({
					collection: CHILD_COLLECTION,
					field: FK_FIELD,
					related_collection: PARENT_COLLECTION,
					meta: { one_field: alias },
					schema: { on_delete: 'CASCADE' },
				});

			expect(response.statusCode).toBe(200);
			expect(response.body.data.meta.one_field).toBe(alias);
			expect(response.body.data.schema.on_delete).toBe('CASCADE');

			const ping = await request(getUrl(vendor)).get('/server/ping');

			expect(ping.statusCode).toBe(200);
			expect(ping.text).toBe('pong');
		});
	});

	describe('PATCH /relations/:collection/:field with an explicit schema: null does not crash the API process', () => {
		it.each(vendors)('%s', async (vendor) => {
			const response = await request(getUrl(vendor))
				.patch(`/relations/${CHILD_COLLECTION}/${FK_FIELD}`)
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`)
				.send({ schema: null });

			expect(response.statusCode).toBe(200);

			const ping = await request(getUrl(vendor)).get('/server/ping');

			expect(ping.statusCode).toBe(200);
			expect(ping.text).toBe('pong');
		});
	});
});
