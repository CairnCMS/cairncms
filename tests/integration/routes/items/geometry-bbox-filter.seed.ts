import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { CreateCollection, CreateField, CreateItem } from '../../fixtures/seeded';

export const collection = 'test_items_geometry_bbox_filter';
export const geometryVendors = ['postgres', 'postgres10'];

export const seedDBStructure = async (api: Api) => {
	const created = await CreateCollection(api, { collection, primaryKeyType: 'integer' });
	expect(created?.collection).toBe(collection);

	const locationField = await CreateField(api, {
		collection,
		field: 'location',
		type: 'geometry.Point',
		meta: { interface: 'map', special: ['geometry.Point'] },
	});

	expect(locationField?.field).toBe('location');

	const labelField = await CreateField(api, { collection, field: 'label', type: 'string' });
	expect(labelField?.field).toBe('label');
};

export const seedDBValues = async (api: Api) => {
	const items = [
		{ label: 'inside', location: { type: 'Point', coordinates: [10, 10] } },
		{ label: 'outside', location: { type: 'Point', coordinates: [50, 50] } },
	];

	for (const item of items) {
		const created = await CreateItem(api, { collection, item });
		expect(created?.id).toBeDefined();
	}

	return true;
};
