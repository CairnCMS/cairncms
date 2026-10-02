import { describe, expect } from 'vitest';
import { createFieldsTest } from './schema-fixtures';
import * as common from '../../fixtures/identities';
import request from '../../fixtures/request';
import { seedFieldSchemaEvents } from './schema-fixtures';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const test = createFieldsTest(true);
const collection = 'test_fields_crud';

describe.each(common.PRIMARY_KEY_TYPES)('/fields', (pkType) => {
	describe(`pkType: ${pkType}`, () => {
		const TEST_COLLECTION_NAME = `${collection}_${pkType}`;

		describe('Verify schema action hook run', () => {
			test('REST', async ({ api }) => {
				await seedFieldSchemaEvents(api, pkType);

				// Action
				const response = await request(api.url)
					.get('/items/tests_extensions_log')
					.query({
						filter: {
							key: {
								_starts_with: `action-verify-schema/${TEST_COLLECTION_NAME}`,
							},
						},
					})
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

				// Assert
				expect(response.statusCode).toBe(200);
				expect(response.body.data.length).toBe(4);

				for (const log of response.body.data) {
					expect(log.value).toBe('1');
				}
			});
		});
	});
});
