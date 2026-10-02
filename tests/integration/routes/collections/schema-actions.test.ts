import { describe, expect } from 'vitest';
import { createIdentityTest } from '../../fixtures/identities';
import * as common from '../../fixtures/identities';
import request from '../../fixtures/request';
import { seedCollectionSchemaEvents } from './schema-fixtures';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const test = createIdentityTest({ env: { CACHE_SCHEMA: 'false' }, hookFixtures: ['action-verify-schema'] });

describe.each(common.PRIMARY_KEY_TYPES)('/collections', (pkType) => {
	describe(`pkType: ${pkType}`, () => {
		describe('Verify schema action hook run', () => {
			test('REST', async ({ api }) => {
				await seedCollectionSchemaEvents(api, pkType);

				// Action
				const response = await request(api.url)
					.get('/items/tests_extensions_log')
					.query({
						filter: JSON.stringify({
							_and: [
								{
									key: {
										_starts_with: 'action-verify-schema/test_collections_crud',
									},
								},
								{
									key: {
										_contains: pkType,
									},
								},
							],
						}),
					})
					.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

				// Assert
				expect(response.statusCode).toBe(200);
				expect(response.body.data.length).toBe(10);

				for (const log of response.body.data) {
					expect(log.value).toBe('1');
				}
			});
		});
	});
});
