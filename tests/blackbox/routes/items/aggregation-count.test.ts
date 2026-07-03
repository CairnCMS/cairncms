import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import request from 'supertest';
import { collectionParents, seedDBValues } from './aggregation-count.seed';

let isSeeded = false;

beforeAll(async () => {
	isSeeded = await seedDBValues();
}, 300000);

test('Seed Database Values', () => {
	expect(isSeeded).toStrictEqual(true);
});

describe.each(common.PRIMARY_KEY_TYPES)('/items countDistinct aggregation', (pkType) => {
	const localCollectionParents = `${collectionParents}_${pkType}`;

	describe(`pkType: ${pkType}`, () => {
		describe('counts distinct primary keys without a join', () => {
			it.each(vendors)('%s', async (vendor) => {
				// Action
				const response = await request(getUrl(vendor))
					.get(`/items/${localCollectionParents}`)
					.query({ 'aggregate[countDistinct]': 'id' })
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

				// Assert
				expect(response.statusCode).toBe(200);
				expect(Number(response.body.data[0].countDistinct.id)).toBe(3);
			});
		});

		describe('counts distinct primary keys under a fanned-out relational filter', () => {
			it.each(vendors)('%s', async (vendor) => {
				// The children-name filter joins the o2m children, fanning the first parent into three
				// rows (four joined rows total). The correct distinct parent count is 2.
				const response = await request(getUrl(vendor))
					.get(`/items/${localCollectionParents}`)
					.query({
						'aggregate[countDistinct]': 'id',
						filter: JSON.stringify({ children_ids: { name: { _nnull: true } } }),
					})
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

				// Assert
				expect(response.statusCode).toBe(200);
				expect(Number(response.body.data[0].countDistinct.id)).toBe(2);
			});
		});
	});
});
