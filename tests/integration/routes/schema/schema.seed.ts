import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import {
	CreateCollection,
	CreateField,
	DeleteCollection,
	PRIMARY_KEY_TYPES,
	CreateFieldM2M,
	CreateFieldM2A,
	CreateFieldM2O,
	CreateFieldO2M,
	DeleteField,
	PrimaryKeyType,
} from '../../common/functions';
import { seedAllFieldTypesStructure } from '../items/seed-all-field-types';

export const collectionAll = 'test_schema_all';
export const collectionM2O = 'test_schema_m2o';
export const collectionM2O2 = 'test_schema_m2o2';
export const collectionO2M = 'test_schema_o2m';
export const collectionO2M2 = 'test_schema_o2m2';
export const collectionM2M = 'test_schema_m2m';
export const collectionM2M2 = 'test_schema_m2m2';
export const junctionM2M = 'test_schema_jm2m';
export const junctionM2M2 = 'test_schema_jm2m2';
export const collectionM2A = 'test_schema_m2a';
export const collectionM2A2 = 'test_schema_m2a2';
export const junctionM2A = 'test_schema_jm2a';
export const junctionM2A2 = 'test_schema_jm2a2';
export const collectionSelf = 'test_schema_self';
export const junctionSelfM2M = 'test_schema_jm2m_self';
export const tempTestCollection = 'temp_test_collection';

export type SampleItem = {
	id?: number | string;
	name: string;
};

export type Ingredient = {
	id?: number | string;
	name: string;
};

export type Supplier = {
	id?: number | string;
	name: string;
};

export const deleteAllCollections = async (api: Api, pkType: PrimaryKeyType, setDefaultValues: boolean) => {
	const suffix = setDefaultValues ? '2' : '';

	// Setup
	const localCollectionAll = `${collectionAll}_${pkType}${suffix}`;
	const localCollectionM2M = `${collectionM2M}_${pkType}${suffix}`;
	const localCollectionM2M2 = `${collectionM2M2}_${pkType}${suffix}`;
	const localJunctionAllM2M = `${junctionM2M}_${pkType}${suffix}`;
	const localJunctionM2MM2M2 = `${junctionM2M2}_${pkType}${suffix}`;
	const localCollectionM2A = `${collectionM2A}_${pkType}${suffix}`;
	const localCollectionM2A2 = `${collectionM2A2}_${pkType}${suffix}`;
	const localJunctionAllM2A = `${junctionM2A}_${pkType}${suffix}`;
	const localJunctionM2AM2A2 = `${junctionM2A2}_${pkType}${suffix}`;
	const localCollectionM2O = `${collectionM2O}_${pkType}${suffix}`;
	const localCollectionM2O2 = `${collectionM2O2}_${pkType}${suffix}`;
	const localCollectionO2M = `${collectionO2M}_${pkType}${suffix}`;
	const localCollectionO2M2 = `${collectionO2M2}_${pkType}${suffix}`;
	const localCollectionSelf = `${collectionSelf}_${pkType}${suffix}`;
	const localJunctionSelfM2M = `${junctionSelfM2M}_${pkType}${suffix}`;

	// Delete existing collections
	await DeleteField(api, { collection: localCollectionSelf, field: 'self_id' });
	await DeleteField(api, { collection: localCollectionSelf, field: 'self_id' });
	await DeleteCollection(api, { collection: localJunctionSelfM2M });
	await DeleteCollection(api, { collection: localCollectionSelf });
	await DeleteCollection(api, { collection: localCollectionO2M2 });
	await DeleteCollection(api, { collection: localCollectionO2M });
	await DeleteCollection(api, { collection: localJunctionM2MM2M2 });
	await DeleteCollection(api, { collection: localJunctionAllM2M });
	await DeleteCollection(api, { collection: localCollectionM2M2 });
	await DeleteCollection(api, { collection: localCollectionM2M });
	await DeleteCollection(api, { collection: localJunctionM2AM2A2 });
	await DeleteCollection(api, { collection: localJunctionAllM2A });
	await DeleteCollection(api, { collection: localCollectionM2A2 });
	await DeleteCollection(api, { collection: localCollectionM2A });
	await DeleteCollection(api, { collection: localCollectionAll });
	await DeleteCollection(api, { collection: localCollectionM2O });
	await DeleteCollection(api, { collection: localCollectionM2O2 });
};

export const seedDBStructure = async (api: Api, vendor: string) => {
	for (const setDefaultValues of [false, true]) {
		const suffix = setDefaultValues ? '2' : '';

		for (const pkType of PRIMARY_KEY_TYPES) {
			try {
				const localCollectionAll = `${collectionAll}_${pkType}${suffix}`;
				const localCollectionM2M = `${collectionM2M}_${pkType}${suffix}`;
				const localCollectionM2M2 = `${collectionM2M2}_${pkType}${suffix}`;
				const localJunctionAllM2M = `${junctionM2M}_${pkType}${suffix}`;
				const localJunctionM2MM2M2 = `${junctionM2M2}_${pkType}${suffix}`;
				const localCollectionM2A = `${collectionM2A}_${pkType}${suffix}`;
				const localCollectionM2A2 = `${collectionM2A2}_${pkType}${suffix}`;
				const localJunctionAllM2A = `${junctionM2A}_${pkType}${suffix}`;
				const localJunctionM2AM2A2 = `${junctionM2A2}_${pkType}${suffix}`;
				const localCollectionM2O = `${collectionM2O}_${pkType}${suffix}`;
				const localCollectionM2O2 = `${collectionM2O2}_${pkType}${suffix}`;
				const localCollectionO2M = `${collectionO2M}_${pkType}${suffix}`;
				const localCollectionO2M2 = `${collectionO2M2}_${pkType}${suffix}`;
				const localCollectionSelf = `${collectionSelf}_${pkType}${suffix}`;
				const localJunctionSelfM2M = `${junctionSelfM2M}_${pkType}${suffix}`;

				// Delete existing collections
				await deleteAllCollections(api, pkType, setDefaultValues);

				// Delete the temp collection created in previous test run
				await DeleteCollection(api, { collection: tempTestCollection });

				// Create All collection
				await CreateCollection(api, {
					collection: localCollectionAll,
					primaryKeyType: pkType,
				});

				await CreateField(api, {
					collection: localCollectionAll,
					field: 'name',
					type: 'string',
				});

				// Create M2M collection
				await CreateCollection(api, {
					collection: localCollectionM2M,
					primaryKeyType: pkType,
				});

				// Create nested M2M collection
				await CreateCollection(api, {
					collection: localCollectionM2M2,
					primaryKeyType: pkType,
				});

				// Create M2M relationships
				await CreateFieldM2M(api, {
					collection: localCollectionAll,
					field: 'all_m2m',
					otherCollection: localCollectionM2M,
					otherField: 'm2m_all',
					junctionCollection: localJunctionAllM2M,
					primaryKeyType: pkType,
				});

				await CreateFieldM2M(api, {
					collection: localCollectionM2M,
					field: 'm2m_m2m2',
					otherCollection: localCollectionM2M2,
					otherField: 'm2m2_m2m',
					junctionCollection: localJunctionM2MM2M2,
					primaryKeyType: pkType,
				});

				// Create M2A collection
				await CreateCollection(api, {
					collection: localCollectionM2A,
					primaryKeyType: pkType,
				});

				// Create nested M2A collection
				await CreateCollection(api, {
					collection: localCollectionM2A2,
					primaryKeyType: pkType,
				});

				// Create M2A relationships
				await CreateFieldM2A(api, {
					collection: localCollectionAll,
					field: 'all_m2a',
					junctionCollection: localJunctionAllM2A,
					relatedCollections: [localCollectionM2A],
					primaryKeyType: pkType,
				});

				await CreateFieldM2A(api, {
					collection: localCollectionM2A,
					field: 'm2a_m2a2',
					junctionCollection: localJunctionM2AM2A2,
					relatedCollections: [localCollectionM2A2],
					primaryKeyType: pkType,
				});

				// Create M2O collection
				await CreateCollection(api, {
					collection: localCollectionM2O,
					primaryKeyType: pkType,
				});

				// Create nested M2O collection
				await CreateCollection(api, {
					collection: localCollectionM2O2,
					primaryKeyType: pkType,
				});

				// Create M2O relationships
				await CreateFieldM2O(api, {
					collection: localCollectionAll,
					field: 'all_id',
					primaryKeyType: pkType,
					otherCollection: localCollectionM2O,
				});

				await CreateFieldM2O(api, {
					collection: localCollectionM2O,
					field: 'm2o_id',
					primaryKeyType: pkType,
					otherCollection: localCollectionM2O2,
				});

				// Create O2M collection
				await CreateCollection(api, {
					collection: localCollectionO2M,
					primaryKeyType: pkType,
				});

				// Create nested O2M collection
				await CreateCollection(api, {
					collection: localCollectionO2M2,
					primaryKeyType: pkType,
				});

				// Create O2M relationships
				await CreateFieldO2M(api, {
					collection: localCollectionAll,
					field: 'o2m',
					otherCollection: localCollectionO2M,
					otherField: 'all_id',
					primaryKeyType: pkType,
				});

				await CreateFieldO2M(api, {
					collection: localCollectionO2M,
					field: 'o2m2',
					otherCollection: localCollectionO2M2,
					otherField: 'o2m_id',
					primaryKeyType: pkType,
				});

				// Create Self collection
				await CreateCollection(api, {
					collection: localCollectionSelf,
					primaryKeyType: pkType,
				});

				// Create self M2M relationship
				await CreateFieldM2M(api, {
					collection: localCollectionSelf,
					field: 'm2m',
					otherCollection: localCollectionSelf,
					otherField: 'm2m2',
					junctionCollection: localJunctionSelfM2M,
					primaryKeyType: pkType,
					relationSchema: {
						on_delete: 'SET NULL',
					},
					otherRelationSchema:
						vendor === 'mssql'
							? { on_delete: 'NO ACTION' }
							: {
									on_delete: 'SET NULL',
							  },
				});

				// Create self O2M relationship
				await CreateFieldO2M(api, {
					collection: localCollectionSelf,
					field: 'o2m',
					otherCollection: localCollectionSelf,
					otherField: 'self_id',
					primaryKeyType: pkType,
					relationSchema: {
						on_delete: 'NO ACTION',
					},
				});

				await seedAllFieldTypesStructure(api, vendor, localCollectionAll, setDefaultValues);
				await seedAllFieldTypesStructure(api, vendor, localCollectionSelf, setDefaultValues);

				expect(true).toBeTruthy();
			} catch (error) {
				expect(error).toBeFalsy();
			}
		}
	}
};
