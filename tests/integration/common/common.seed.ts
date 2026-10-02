import { expect } from 'vitest';
import type { Api } from '../fixtures/environment';

import { DeleteCollection } from '../common/functions';

export const collectionName = 'common_test_collection';
export const collectionNameM2O = 'common_test_collection_m2o';
export const collectionNameO2M = 'common_test_collection_o2m';

export const seedDBStructure = async (api: Api) => {
	try {
		// Delete existing collections
		await DeleteCollection(api, { collection: collectionNameO2M });
		await DeleteCollection(api, { collection: collectionNameM2O });
		await DeleteCollection(api, { collection: collectionName });

		expect(true).toBeTruthy();
	} catch (error) {
		expect(error).toBeFalsy();
	}
};
