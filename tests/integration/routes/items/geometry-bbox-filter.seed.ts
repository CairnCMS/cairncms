import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { setupRequest } from '../../fixtures/request';
import { CreateCollection, CreateField, CreateItem, CreateRole } from '../../fixtures/seeded';
import { vendorsWith } from '../../harness/database-vendors.mjs';

export const collection = 'test_items_geometry_bbox_filter';
export const geometryVendors = vendorsWith('postgis');

function box(minimum: number, maximum: number) {
	return {
		type: 'Polygon',
		coordinates: [
			[
				[minimum, minimum],
				[maximum, minimum],
				[maximum, maximum],
				[minimum, maximum],
				[minimum, minimum],
			],
		],
	};
}

export const tenants = {
	near: { token: 'GeometryRegionNearToken', email: 'geometry-region-near@example.com', region: box(0, 20) },
	far: { token: 'GeometryRegionFarToken', email: 'geometry-region-far@example.com', region: box(40, 60) },
};

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

	const areaField = await CreateField(api, { collection, field: 'area', type: 'geometry', meta: { interface: 'map' } });
	expect(areaField?.field).toBe('area');

	const labelField = await CreateField(api, { collection, field: 'label', type: 'string' });
	expect(labelField?.field).toBe('label');

	const regionField = await CreateField(api, {
		collection: 'directus_users',
		field: 'region',
		type: 'geometry.Polygon',
		meta: { interface: 'map', special: ['geometry.Polygon'] },
	});

	expect(regionField?.field).toBe('region');

	const role = await CreateRole(api, {
		name: 'Geometry region reader',
		appAccessEnabled: false,
		adminAccessEnabled: false,
	});

	expect(role?.id).toBeDefined();

	await setupRequest(api.url)
		.post('/permissions')
		.auth(api.adminToken, { type: 'bearer' })
		.send({
			role: role.id,
			collection,
			action: 'read',
			fields: ['label'],
			permissions: { location: { _intersects: '$CURRENT_USER.region' } },
		});

	for (const tenant of Object.values(tenants)) {
		await setupRequest(api.url)
			.post('/users')
			.auth(api.adminToken, { type: 'bearer' })
			.send({ email: tenant.email, token: tenant.token, role: role.id, region: tenant.region });
	}
};

export const seedDBValues = async (api: Api) => {
	const items = [
		{
			label: 'inside',
			location: { type: 'Point', coordinates: [10, 10] },
			area: { type: 'Point', coordinates: [10, 10] },
		},
		{
			label: 'outside',
			location: { type: 'Point', coordinates: [50, 50] },
			area: { type: 'Point', coordinates: [50, 50] },
		},
	];

	for (const item of items) {
		const created = await CreateItem(api, { collection, item });
		expect(created?.id).toBeDefined();
	}

	return true;
};
