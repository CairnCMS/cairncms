import request from 'supertest';
import { getUrl } from '@common/config';
import * as common from '@common/index';
import { collection, geometryVendors, seedDBValues } from './geometry-bbox-filter.seed';

let isSeeded = false;

beforeAll(async () => {
	isSeeded = await seedDBValues();
}, 300000);

test('Seed Database Values', () => {
	expect(isSeeded).toStrictEqual(true);
});

describe('geometry bbox filter', () => {
	const bbox = {
		type: 'Polygon',
		coordinates: [
			[
				[0, 0],
				[20, 0],
				[20, 20],
				[0, 20],
				[0, 0],
			],
		],
	};

	describe('_intersects_bbox on a typed geometry field returns only rows inside the box', () => {
		it.each(geometryVendors)('%s', async (vendor) => {
			const response = await request(getUrl(vendor))
				.get(`/items/${collection}`)
				.query({ filter: JSON.stringify({ location: { _intersects_bbox: bbox } }), fields: 'label' })
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(response.body.data.length).toBe(1);
			expect(response.body.data[0].label).toBe('inside');
		});
	});

	describe('_nintersects_bbox on a typed geometry field returns only rows outside the box', () => {
		it.each(geometryVendors)('%s', async (vendor) => {
			const response = await request(getUrl(vendor))
				.get(`/items/${collection}`)
				.query({ filter: JSON.stringify({ location: { _nintersects_bbox: bbox } }), fields: 'label' })
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(response.body.data.length).toBe(1);
			expect(response.body.data[0].label).toBe('outside');
		});
	});
});
