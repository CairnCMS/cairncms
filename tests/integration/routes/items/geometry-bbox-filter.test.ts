import { describe, expect, vi } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import { createSeededTest, USER } from '../../fixtures/seeded';
import request from '../../fixtures/request';
import { collection, geometryVendors, seedDBStructure, seedDBValues } from './geometry-bbox-filter.seed';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

vi.setConfig({ hookTimeout: 300_000 });
initializeFixtures();

const test = createSeededTest({ seedDBStructure, seedDBValues, tables: [collection] });

describeForVendors('geometry bbox filter', geometryVendors, 'Requires a PostGIS-capable vendor.', () => {
	test('Seed Database Values', async ({ isSeeded }) => {
		expect(isSeeded).toStrictEqual(true);
	});

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
		test('REST', async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${collection}`)
				.query({ filter: JSON.stringify({ location: { _intersects_bbox: bbox } }), fields: 'label' })
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(response.body.data.length).toBe(1);
			expect(response.body.data[0].label).toBe('inside');
		});
	});

	describe('_nintersects_bbox on a typed geometry field returns only rows outside the box', () => {
		test('REST', async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${collection}`)
				.query({ filter: JSON.stringify({ location: { _nintersects_bbox: bbox } }), fields: 'label' })
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(response.body.data.length).toBe(1);
			expect(response.body.data[0].label).toBe('outside');
		});
	});
});
