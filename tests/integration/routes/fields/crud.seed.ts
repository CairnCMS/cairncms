import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import { CreateCollection, DeleteCollection, PRIMARY_KEY_TYPES } from '../../common/functions';

export const collection = 'test_fields_crud';

export const seedDBStructure = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		try {
			const localCollection = `${collection}_${pkType}`;

			// Delete existing collections
			await DeleteCollection(api, { collection: localCollection });

			// Create countries collection
			await CreateCollection(api, {
				collection: localCollection,
				primaryKeyType: pkType,
			});

			expect(true).toBeTruthy();
		} catch (error) {
			expect(error).toBeFalsy();
		}
	}
};
