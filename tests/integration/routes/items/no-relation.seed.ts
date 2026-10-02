import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import { CreateCollection, CreateField, DeleteCollection } from '../../common/functions';
import { PRIMARY_KEY_TYPES } from '../../fixtures/identities';

export const collectionArtists = 'test_items_no_relations_artists';

export const seedDBStructure = async (api: Api) => {
	for (const pkType of PRIMARY_KEY_TYPES) {
		try {
			const localCollectionArtists = `${collectionArtists}_${pkType}`;

			// Delete existing collections
			await DeleteCollection(api, { collection: localCollectionArtists });

			// Create artists collection
			await CreateCollection(api, {
				collection: localCollectionArtists,
				primaryKeyType: pkType,
				meta: {},
				schema: {},
			});

			await CreateField(api, {
				collection: localCollectionArtists,
				field: 'name',
				type: 'string',
				meta: {},
				schema: {},
			});

			await CreateField(api, {
				collection: localCollectionArtists,
				field: 'company',
				type: 'string',
				meta: {},
				schema: {},
			});

			expect(true).toBeTruthy();
		} catch (error) {
			expect(error).toBeFalsy();
		}
	}
};
