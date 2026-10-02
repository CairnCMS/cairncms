import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import {
	CreateCollection,
	CreateField,
	CreateFieldO2M,
	CreateItem,
	SeedFunctions,
	PrimaryKeyType,
	PRIMARY_KEY_TYPES,
} from '../../fixtures/data';
import { CachedTestsSchema, TestsSchema, TestsSchemaVendorValues } from '../../query/filter';
import { set } from 'lodash';

export const collectionCountries = 'test_fields_change_field_countries';
export const collectionStates = 'test_fields_change_field_states';

export type Country = {
	id?: number | string;
	name: string;
};

export type State = {
	id?: number | string;
	name: string;
	country_id?: number | string | null;
};

export type City = {
	id?: number | string;
	name: string;
	state_id?: number | string | null;
};

export function getTestsSchema(pkType: PrimaryKeyType, seed?: string): TestsSchema {
	const schema: TestsSchema = {
		[`${collectionCountries}_${pkType}`]: {
			id: {
				field: 'id',
				type: pkType,
				isPrimaryKey: true,
				filters: true,
				possibleValues: SeedFunctions.generatePrimaryKeys(pkType, {
					quantity: 2,
					seed: `${collectionCountries}${seed}`,
					incremental: true,
				}),
			},
			name: {
				field: 'name',
				type: 'string',
				filters: true,
				possibleValues: ['United States', 'Malaysia'],
			},
		},
	};

	schema[`${collectionStates}_${pkType}`] = {
		id: {
			field: 'id',
			type: pkType,
			isPrimaryKey: true,
			filters: false,
			possibleValues: SeedFunctions.generatePrimaryKeys(pkType, {
				quantity: 4,
				seed: `${collectionStates}${seed}`,
				incremental: true,
			}),
		},
		name: {
			field: 'name',
			type: 'string',
			filters: false,
			possibleValues: ['Washington', 'California', 'Johor', 'Sarawak'],
		},
	};

	schema[`${collectionCountries}_${pkType}`]['states'] = {
		field: 'states',
		type: 'alias',
		filters: false,
		possibleValues: schema[`${collectionStates}_${pkType}`].id.possibleValues,
		children: schema[`${collectionStates}_${pkType}`],
		relatedCollection: `${collectionStates}_${pkType}`,
	};

	return schema;
}

export const seedDBStructure = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		try {
			const localCollectionCountries = `${collectionCountries}_${pkType}`;
			const localCollectionStates = `${collectionStates}_${pkType}`;

			// Delete existing collections

			// Create countries collection
			await CreateCollection(api, {
				collection: localCollectionCountries,
				primaryKeyType: pkType,
			});

			await CreateField(api, {
				collection: localCollectionCountries,
				field: 'name',
				type: 'string',
			});

			// Create states collection
			await CreateCollection(api, {
				collection: localCollectionStates,
				primaryKeyType: pkType,
			});

			await CreateField(api, {
				collection: localCollectionStates,
				field: 'name',
				type: 'string',
			});

			// Create O2M relationships
			await CreateFieldO2M(api, {
				collection: localCollectionCountries,
				field: 'states',
				otherCollection: localCollectionStates,
				otherField: 'country_id',
				primaryKeyType: pkType,
			});

			expect(true).toBeTruthy();
		} catch (error) {
			expect(error).toBeFalsy();
		}
	}
};

export const seedDBValues = async (
	api: Api,
	vendor: string,
	cachedSchema: CachedTestsSchema,
	vendorSchemaValues: TestsSchemaVendorValues
) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		const schema = cachedSchema[pkType];

		const localCollectionCountries = `${collectionCountries}_${pkType}`;
		const localCollectionStates = `${collectionStates}_${pkType}`;

		// Create countries
		const itemCountries = [];

		for (let i = 0; i < schema[localCollectionCountries].id.possibleValues.length; i++) {
			const country: Country = {
				name: schema[localCollectionCountries].name.possibleValues[i],
			};

			if (pkType === 'string') {
				country.id = schema[localCollectionCountries].id.possibleValues[i];
			}

			itemCountries.push(country);
		}

		const countries = await CreateItem(api, {
			collection: localCollectionCountries,
			item: itemCountries,
		});

		const countriesIDs = countries.map((country: Country) => country.id);

		set(vendorSchemaValues, `${vendor}.${localCollectionCountries}.id`, countriesIDs);

		// Create states
		const itemStates = [];

		for (let i = 0; i < schema[localCollectionStates].id.possibleValues.length; i++) {
			const state: State = {
				name: schema[localCollectionStates].name.possibleValues[i],
				country_id: countriesIDs[i % countriesIDs.length],
			};

			if (pkType === 'string') {
				state.id = schema[localCollectionStates].id.possibleValues[i];
			}

			itemStates.push(state);
		}

		const states = await CreateItem(api, {
			collection: localCollectionStates,
			item: itemStates,
		});

		const statesIDs = states.map((state: State) => state.id);

		set(vendorSchemaValues, `${vendor}.${localCollectionStates}.id`, statesIDs);
	}
};
