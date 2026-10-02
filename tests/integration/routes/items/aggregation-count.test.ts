import { describe, expect } from 'vitest';
import { createSeededTest } from '../../fixtures/seeded';

import * as common from '../../fixtures/seeded';
import request from '../../fixtures/request';
import { collectionParents, seedDBValues, seedDBStructure } from './aggregation-count.seed';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const test = createSeededTest({
	seedDBStructure,
	seedDBValues,
	tables: common.PRIMARY_KEY_TYPES.flatMap((pkType) =>
		['test_items_agg_count_parents', 'test_items_agg_count_children'].map((table) => table + '_' + pkType)
	),
});

test('Seed Database Values', async ({ isSeeded }) => {
	expect(isSeeded).toStrictEqual(true);
});

describe.each(common.PRIMARY_KEY_TYPES)('/items countDistinct aggregation', (pkType) => {
	const localCollectionParents = `${collectionParents}_${pkType}`;

	describe(`pkType: ${pkType}`, () => {
		describe('counts distinct primary keys without a join', () => {
			test('REST', async ({ api }) => {
				// Action
				const response = await request(api.url)
					.get(`/items/${localCollectionParents}`)
					.query({ 'aggregate[countDistinct]': 'id' })
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

				// Assert
				expect(response.statusCode).toBe(200);
				expect(Number(response.body.data[0].countDistinct.id)).toBe(3);
			});
		});

		describe('counts distinct primary keys under a fanned-out relational filter', () => {
			test('REST', async ({ api }) => {
				// The children-name filter joins the o2m children, fanning the first parent into three
				// rows (four joined rows total). The correct distinct parent count is 2.
				const response = await request(api.url)
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
