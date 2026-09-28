import vendors from '@common/get-dbs-to-test';
import { CreateCollection, CreateField, CreateItem, DeleteCollection } from '@common/index';

export const collection = 'test_items_geometry_bbox_filter';

export const geometryVendors = vendors.filter((vendor) => vendor === 'postgres' || vendor === 'postgres10');

export const seedDBStructure = () => {
	it.each(geometryVendors)(
		'%s',
		async (vendor) => {
			await DeleteCollection(vendor, { collection });

			const created = await CreateCollection(vendor, { collection, primaryKeyType: 'integer' });
			expect(created?.collection).toBe(collection);

			const locationField = await CreateField(vendor, {
				collection,
				field: 'location',
				type: 'geometry.Point',
				meta: { interface: 'map', special: ['geometry.Point'] },
			});

			expect(locationField?.field).toBe('location');

			const labelField = await CreateField(vendor, { collection, field: 'label', type: 'string' });
			expect(labelField?.field).toBe('label');
		},
		300000
	);
};

export const seedDBValues = async () => {
	let isSeeded = true;

	await Promise.all(
		geometryVendors.map(async (vendor) => {
			const items = [
				{ label: 'inside', location: { type: 'Point', coordinates: [10, 10] } },
				{ label: 'outside', location: { type: 'Point', coordinates: [50, 50] } },
			];

			for (const item of items) {
				const created = await CreateItem(vendor, { collection, item });
				expect(created?.id).toBeDefined();
			}
		})
	)
		.then(() => {
			isSeeded = true;
		})
		.catch(() => {
			isSeeded = false;
		});

	return isSeeded;
};
