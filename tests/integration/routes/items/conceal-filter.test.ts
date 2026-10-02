import { describe, expect } from 'vitest';
import { createSeededTest } from '../../fixtures/seeded';
import request from '../../fixtures/request';

import * as common from '../../fixtures/seeded';
import { collectionFirst, collectionSecond, seedDBValues, seedDBStructure } from './conceal-filter.seed';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const test = createSeededTest({
	seedDBStructure,
	seedDBValues,
	tables: common.PRIMARY_KEY_TYPES.flatMap((pkType) =>
		['test_items_conceal_filter_first', 'test_items_conceal_filter_second'].map((table) => table + '_' + pkType)
	),
});

test('Seed Database Values', async ({ isSeeded }) => {
	expect(isSeeded).toStrictEqual(true);
});

describe.each(common.PRIMARY_KEY_TYPES)('/items', (pkType) => {
	const localCollectionFirst = `${collectionFirst}_${pkType}`;
	const localCollectionSecond = `${collectionSecond}_${pkType}`;

	describe(`pkType: ${pkType}`, () => {
		describe(`GET /${localCollectionFirst}`, () => {
			describe('retrieves items without filters', () => {
				test('REST', async ({ api }) => {
					// Action
					const response = await request(api.url)
						.get(`/items/${localCollectionFirst}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/items/${localCollectionSecond}`)
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toEqual(200);
					expect(response.body.data.length).toBe(2);
					expect(response2.statusCode).toEqual(200);
					expect(response2.body.data.length).toBe(2);
				});
			});

			describe('retrieves items with filters (non-relational)', () => {
				test('REST', async ({ api }) => {
					// Action
					const response = await request(api.url)
						.get(`/items/${localCollectionFirst}`)
						.query({
							filter: JSON.stringify({ string_field: { _null: true } }),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/items/${localCollectionFirst}`)
						.query({
							filter: JSON.stringify({ string_field: { _nnull: true } }),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response3 = await request(api.url)
						.get(`/items/${localCollectionSecond}`)
						.query({
							filter: JSON.stringify({ string_field: { _null: true } }),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response4 = await request(api.url)
						.get(`/items/${localCollectionSecond}`)
						.query({
							filter: JSON.stringify({ string_field: { _nnull: true } }),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toEqual(200);
					expect(response.body.data.length).toBe(1);
					expect(response2.statusCode).toEqual(200);
					expect(response2.body.data.length).toBe(1);
					expect(response3.statusCode).toEqual(200);
					expect(response3.body.data.length).toBe(1);
					expect(response4.statusCode).toEqual(200);
					expect(response4.body.data.length).toBe(1);
				});
			});

			describe('errors with invalid filters (non-relational)', () => {
				test('REST', async ({ api }) => {
					// Action
					const response = await request(api.url)
						.get(`/items/${localCollectionFirst}`)
						.query({
							filter: JSON.stringify({ string_field: { _contains: 'a' } }),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/items/${localCollectionFirst}`)
						.query({
							filter: JSON.stringify({ string_field: { _eq: 'b' } }),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response3 = await request(api.url)
						.get(`/items/${localCollectionSecond}`)
						.query({
							filter: JSON.stringify({ string_field: { _starts_with: 'c' } }),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response4 = await request(api.url)
						.get(`/items/${localCollectionSecond}`)
						.query({
							filter: JSON.stringify({ string_field: { _ends_with: 'd' } }),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toEqual(400);
					expect(response2.statusCode).toEqual(400);
					expect(response3.statusCode).toEqual(400);
					expect(response4.statusCode).toEqual(400);
				});
			});

			describe('retrieves items with filters (relational)', () => {
				test('REST', async ({ api }) => {
					// Action
					const response = await request(api.url)
						.get(`/items/${localCollectionFirst}`)
						.query({
							filter: JSON.stringify({
								second_ids: { string_field: { _null: true } },
							}),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/items/${localCollectionFirst}`)
						.query({
							filter: JSON.stringify({
								second_ids: { string_field: { _null: true } },
							}),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response3 = await request(api.url)
						.get(`/items/${localCollectionSecond}`)
						.query({
							filter: JSON.stringify({
								first_id: { string_field: { _null: true } },
							}),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response4 = await request(api.url)
						.get(`/items/${localCollectionSecond}`)
						.query({
							filter: JSON.stringify({
								first_id: { string_field: { _null: true } },
							}),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toEqual(200);
					expect(response.body.data.length).toBe(1);
					expect(response2.statusCode).toEqual(200);
					expect(response2.body.data.length).toBe(1);
					expect(response3.statusCode).toEqual(200);
					expect(response3.body.data.length).toBe(1);
					expect(response4.statusCode).toEqual(200);
					expect(response4.body.data.length).toBe(1);
				});
			});

			describe('errors with invalid filters (relational)', () => {
				test('REST', async ({ api }) => {
					// Action
					const response = await request(api.url)
						.get(`/items/${localCollectionFirst}`)
						.query({
							filter: JSON.stringify({
								second_ids: { string_field: { _contains: 'a' } },
							}),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response2 = await request(api.url)
						.get(`/items/${localCollectionFirst}`)
						.query({
							filter: JSON.stringify({
								second_ids: { string_field: { _eq: 'b' } },
							}),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response3 = await request(api.url)
						.get(`/items/${localCollectionSecond}`)
						.query({
							filter: JSON.stringify({
								first_id: { string_field: { _starts_with: 'c' } },
							}),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					const response4 = await request(api.url)
						.get(`/items/${localCollectionSecond}`)
						.query({
							filter: JSON.stringify({
								first_id: { string_field: { _ends_with: 'd' } },
							}),
						})
						.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

					// Assert
					expect(response.statusCode).toEqual(400);
					expect(response2.statusCode).toEqual(400);
					expect(response3.statusCode).toEqual(400);
					expect(response4.statusCode).toEqual(400);
				});
			});
		});
	});
});
