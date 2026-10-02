import { setupRequest } from '../../fixtures/request';
import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';

import { CreateItem, SeedFunctions, PrimaryKeyType } from '../../fixtures/data';
import { TestsFieldSchema } from '../../query/filter';

export const seedRelationalFields = async (
	api: Api,
	vendor: string,
	collection: string,
	pkType: PrimaryKeyType,
	testsSchema: TestsFieldSchema
) => {
	try {
		// Create items
		let generatedStringIdCounter = 0;

		for (const key of Object.keys(testsSchema)) {
			// Oracle does not have a time datatype
			if (vendor === 'oracle' && testsSchema[key].type === 'time') {
				continue;
			}

			const items = [];

			if (testsSchema[key].children) {
				const response = await setupRequest(api.url)
					.get(`/items/${testsSchema[key].relatedCollection}`)
					.set('Authorization', `Bearer ${api.adminToken}`)
					.query({ fields: 'id', limit: -1 });

				const primaryKeys = response.body.data.map((item: any) => item.id);

				if (pkType === 'string') {
					for (const pk of primaryKeys) {
						items.push({
							id: SeedFunctions.generateValues.string({
								quantity: 1,
								seed: `relational-id-${generatedStringIdCounter}`,
							})[0],
							[testsSchema[key].field]: pk,
						});

						generatedStringIdCounter++;
					}
				} else {
					for (const pk of primaryKeys) {
						items.push({
							[testsSchema[key].field]: pk,
						});
					}
				}
			}

			if (items.length > 0) {
				await CreateItem(api, {
					collection: collection,
					item: items,
				});
			}
		}

		expect(true).toBeTruthy();
	} catch (error) {
		expect(error).toBeFalsy();
	}
};
