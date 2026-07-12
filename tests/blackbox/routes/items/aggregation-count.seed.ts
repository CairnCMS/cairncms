import vendors from '@common/get-dbs-to-test';
import {
	CreateCollection,
	CreateField,
	CreateFieldO2M,
	CreateItem,
	DeleteCollection,
	PRIMARY_KEY_TYPES,
} from '@common/index';
import { v4 as uuid } from 'uuid';

export const collectionParents = 'test_items_agg_count_parents';
export const collectionChildren = 'test_items_agg_count_children';

export type Parent = {
	id?: number | string;
	name?: string;
};

export type Child = {
	id?: number | string;
	name?: string;
	parent_id?: number | string | null;
};

export const seedDBStructure = () => {
	it.each(vendors)(
		'%s',
		async (vendor) => {
			for (const pkType of PRIMARY_KEY_TYPES) {
				try {
					const localCollectionParents = `${collectionParents}_${pkType}`;
					const localCollectionChildren = `${collectionChildren}_${pkType}`;

					await DeleteCollection(vendor, { collection: localCollectionChildren });
					await DeleteCollection(vendor, { collection: localCollectionParents });

					await CreateCollection(vendor, {
						collection: localCollectionParents,
						primaryKeyType: pkType,
					});

					await CreateField(vendor, {
						collection: localCollectionParents,
						field: 'name',
						type: 'string',
					});

					await CreateCollection(vendor, {
						collection: localCollectionChildren,
						primaryKeyType: pkType,
					});

					await CreateField(vendor, {
						collection: localCollectionChildren,
						field: 'name',
						type: 'string',
					});

					await CreateFieldO2M(vendor, {
						collection: localCollectionParents,
						field: 'children_ids',
						primaryKeyType: pkType,
						otherCollection: localCollectionChildren,
						otherField: 'parent_id',
					});

					expect(true).toBeTruthy();
				} catch (error) {
					expect(error).toBeFalsy();
				}
			}
		},
		300000
	);
};

/*
 * Three parents per pkType. The first parent has THREE named children so an O2M filter join fans its
 * row out, the second has ONE named child, the third has none. Distinct parents matching a
 * children-name filter is therefore 2 while the joined row count is 4, which is the shape that
 * distinguishes countDistinct from a wrongly-optimized plain count under a join.
 */
export const seedDBValues = async () => {
	let isSeeded = true;

	await Promise.all(
		vendors.map(async (vendor) => {
			for (const pkType of PRIMARY_KEY_TYPES) {
				const localCollectionParents = `${collectionParents}_${pkType}`;

				await CreateItem(vendor, {
					collection: localCollectionParents,
					item: {
						id: pkType === 'string' ? uuid() : undefined,
						name: 'parent-many-children',
						children_ids: [
							{ id: pkType === 'string' ? uuid() : undefined, name: 'child-a' },
							{ id: pkType === 'string' ? uuid() : undefined, name: 'child-b' },
							{ id: pkType === 'string' ? uuid() : undefined, name: 'child-c' },
						],
					},
				});

				await CreateItem(vendor, {
					collection: localCollectionParents,
					item: {
						id: pkType === 'string' ? uuid() : undefined,
						name: 'parent-one-child',
						children_ids: [{ id: pkType === 'string' ? uuid() : undefined, name: 'child-d' }],
					},
				});

				await CreateItem(vendor, {
					collection: localCollectionParents,
					item: {
						id: pkType === 'string' ? uuid() : undefined,
						name: 'parent-no-children',
					},
				});
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
