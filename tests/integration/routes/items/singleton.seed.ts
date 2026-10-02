import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import {
	CreateCollection,
	CreateField,
	CreateFieldO2M,
	CreateItem,
	PRIMARY_KEY_TYPES,
	SeedFunctions,
	UpdateItem,
} from '../../fixtures/seeded';

export const collectionSingleton = 'test_items_singleton';
export const collectionSingletonO2M = 'test_items_singleton_o2m';

export type Singleton = {
	id?: number | string;
	name: string;
};

export type SingletonO2M = {
	id?: number | string;
	name: string;
	country_id?: number | string | null;
};

export const seedDBStructure = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		try {
			const localCollectionSingleton = `${collectionSingleton}_${pkType}`;
			const localCollectionSingletonO2M = `${collectionSingletonO2M}_${pkType}`;

			// Create singleton collection
			await CreateCollection(api, {
				collection: localCollectionSingleton,
				primaryKeyType: pkType,
				meta: { singleton: true },
			});

			await CreateField(api, {
				collection: localCollectionSingleton,
				field: 'name',
				type: 'string',
			});

			// Create singleton O2M collection
			await CreateCollection(api, {
				collection: localCollectionSingletonO2M,
				primaryKeyType: pkType,
			});

			await CreateField(api, {
				collection: localCollectionSingletonO2M,
				field: 'name',
				type: 'string',
			});

			// Create O2M relationships
			await CreateFieldO2M(api, {
				collection: localCollectionSingleton,
				field: 'o2m',
				otherCollection: localCollectionSingletonO2M,
				otherField: 'singleton_id',
				primaryKeyType: pkType,
			});

			expect(true).toBeTruthy();
		} catch (error) {
			expect(error).toBeFalsy();
		}
	}
};

export const seedDBValues = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		const localCollectionSingleton = `${collectionSingleton}_${pkType}`;
		const localCollectionSingletonO2M = `${collectionSingletonO2M}_${pkType}`;

		const item = await UpdateItem(api, {
			collection: localCollectionSingleton,
			item: {
				id:
					pkType === 'string'
						? SeedFunctions.generatePrimaryKeys(pkType, { quantity: 1, seed: localCollectionSingleton })[0]
						: undefined,
				name: 'parent',
			},
		});

		await CreateItem(api, {
			collection: localCollectionSingletonO2M,
			item: {
				id:
					pkType === 'string'
						? SeedFunctions.generatePrimaryKeys(pkType, { quantity: 1, seed: localCollectionSingletonO2M })[0]
						: undefined,
				name: 'child_o2m',
				singleton_id: item.id,
			},
		});
	}

	return true;
};
