import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import { CreateCollection, CreateField, CreateFieldO2M, CreateItem, PRIMARY_KEY_TYPES } from '../../fixtures/seeded';
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

export const seedDBStructure = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		try {
			const localCollectionParents = `${collectionParents}_${pkType}`;
			const localCollectionChildren = `${collectionChildren}_${pkType}`;

			await CreateCollection(api, {
				collection: localCollectionParents,
				primaryKeyType: pkType,
			});

			await CreateField(api, {
				collection: localCollectionParents,
				field: 'name',
				type: 'string',
			});

			await CreateCollection(api, {
				collection: localCollectionChildren,
				primaryKeyType: pkType,
			});

			await CreateField(api, {
				collection: localCollectionChildren,
				field: 'name',
				type: 'string',
			});

			await CreateFieldO2M(api, {
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
};

/*
 * Three parents per pkType. The first parent has THREE named children so an O2M filter join fans its
 * row out, the second has ONE named child, the third has none. Distinct parents matching a
 * children-name filter is therefore 2 while the joined row count is 4, which is the shape that
 * distinguishes countDistinct from a wrongly-optimized plain count under a join.
 */
export const seedDBValues = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		const localCollectionParents = `${collectionParents}_${pkType}`;

		await CreateItem(api, {
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

		await CreateItem(api, {
			collection: localCollectionParents,
			item: {
				id: pkType === 'string' ? uuid() : undefined,
				name: 'parent-one-child',
				children_ids: [{ id: pkType === 'string' ? uuid() : undefined, name: 'child-d' }],
			},
		});

		await CreateItem(api, {
			collection: localCollectionParents,
			item: {
				id: pkType === 'string' ? uuid() : undefined,
				name: 'parent-no-children',
			},
		});
	}

	return true;
};
