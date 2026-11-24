import { describe, expect, vi } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import { createSeededTest, USER } from '../../fixtures/seeded';
import request, { requestGraphQL } from '../../fixtures/request';
import { collection, geometryVendors, seedDBStructure, seedDBValues, tenants } from './geometry-bbox-filter.seed';
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

	describe('_intersects_bbox accepts the box as a GeoJSON string', () => {
		test('REST bracket notation', async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${collection}`)
				.query(`filter[location][_intersects_bbox]=${encodeURIComponent(JSON.stringify(bbox))}&fields=label`)
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(labels(response.body.data)).toEqual(['inside']);
		});

		test('REST JSON filter', async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${collection}`)
				.query({ filter: JSON.stringify({ location: { _intersects_bbox: JSON.stringify(bbox) } }), fields: 'label' })
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(labels(response.body.data)).toEqual(['inside']);
		});

		test('GraphQL on a generic geometry field', async ({ api }) => {
			const response = await requestGraphQL(api.url, false, USER.ADMIN.TOKEN, {
				query: {
					[collection]: {
						__args: { filter: { area: { _intersects_bbox: JSON.stringify(bbox) } } },
						label: true,
					},
				},
			});

			expect(response.statusCode).toEqual(200);
			expect(labels(response.body.data[collection])).toEqual(['inside']);
		});
	});

	describe('_intersects accepts a polygon as a GeoJSON string', () => {
		test('REST', async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${collection}`)
				.query({ filter: JSON.stringify({ location: { _intersects: JSON.stringify(bbox) } }), fields: 'label' })
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(labels(response.body.data)).toEqual(['inside']);
		});
	});

	describe('a spatial operand string that is not a GeoJSON object is rejected as an invalid query', () => {
		for (const operand of ['{"type":', '"null"']) {
			test(`REST ${JSON.stringify(operand)}`, async ({ api }) => {
				const response = await request(api.url)
					.get(`/items/${collection}`)
					.query({ filter: JSON.stringify({ location: { _intersects: operand } }), fields: 'label' })
					.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`);

				expect(response.statusCode).toEqual(400);
				expect(response.body.errors[0].extensions.code).toBe('INVALID_QUERY');
			});
		}
	});

	describe('a permission rule on $CURRENT_USER.region shows each user only the rows inside their own region', () => {
		test('REST', async ({ api }) => {
			const near = await request(api.url)
				.get(`/items/${collection}`)
				.query({ fields: 'label' })
				.set('Authorization', `Bearer ${tenants.near.token}`);

			const far = await request(api.url)
				.get(`/items/${collection}`)
				.query({ fields: 'label' })
				.set('Authorization', `Bearer ${tenants.far.token}`);

			expect(near.statusCode).toEqual(200);
			expect(labels(near.body.data)).toEqual(['inside']);
			expect(far.statusCode).toEqual(200);
			expect(labels(far.body.data)).toEqual(['outside']);
		});
	});
});

function labels(items: { label: string }[]) {
	return items.map((item) => item.label).sort();
}
