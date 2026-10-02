import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import { CreateCollection, CreateField, CreateFieldO2M, CreateItem, PRIMARY_KEY_TYPES } from '../../fixtures/seeded';
import { v4 as uuid } from 'uuid';

export const collectionFirst = 'test_items_conceal_filter_first';
export const collectionSecond = 'test_items_conceal_filter_second';

export type First = {
	id?: number | string;
	string_field?: string;
};

export type Second = {
	id?: number | string;
	string_field?: string;
	first_id?: number | string | null;
};

export const seedDBStructure = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		try {
			const localCollectionFirst = `${collectionFirst}_${pkType}`;
			const localCollectionSecond = `${collectionSecond}_${pkType}`;

			// Create first collection
			await CreateCollection(api, {
				collection: localCollectionFirst,
				primaryKeyType: pkType,
			});

			await CreateField(api, {
				collection: localCollectionFirst,
				field: 'string_field',
				type: 'string',
				meta: {
					special: ['conceal'],
				},
			});

			// Create seconds collection
			await CreateCollection(api, {
				collection: localCollectionSecond,
				primaryKeyType: pkType,
			});

			await CreateField(api, {
				collection: localCollectionSecond,
				field: 'string_field',
				type: 'string',
				meta: {
					special: ['conceal'],
				},
			});

			await CreateFieldO2M(api, {
				collection: localCollectionFirst,
				field: 'second_ids',
				primaryKeyType: pkType,
				otherCollection: localCollectionSecond,
				otherField: 'first_id',
			});

			expect(true).toBeTruthy();
		} catch (error) {
			expect(error).toBeFalsy();
		}
	}
};

export const seedDBValues = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		const localCollectionFirst = `${collectionFirst}_${pkType}`;

		// Create nested items with string value
		await CreateItem(api, {
			collection: localCollectionFirst,
			item: {
				id: pkType === 'string' ? uuid() : undefined,
				string_field: uuid(),
				second_ids: [
					{
						id: pkType === 'string' ? uuid() : undefined,
						string_field: uuid(),
					},
				],
			},
		});

		// Create nested items without string value
		await CreateItem(api, {
			collection: localCollectionFirst,
			item: {
				id: pkType === 'string' ? uuid() : undefined,
				second_ids: [
					{
						id: pkType === 'string' ? uuid() : undefined,
					},
				],
			},
		});
	}

	return true;
};
