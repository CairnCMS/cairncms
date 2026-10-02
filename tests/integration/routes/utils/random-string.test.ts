import { describe, expect } from 'vitest';
import { apiTest as test } from '../../fixtures/environment';
import { requestGraphQL } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

describe('/utils/random/string', () => {
	describe('GraphQL', () => {
		describe.each([0, -1])('rejects length %s', (length) => {
			test('GraphQL', async ({ api }) => {
				const response = await requestGraphQL(api.url, true, api.adminToken, {
					mutation: { utils_random_string: { __args: { length } } },
				});

				expect(response.statusCode).toBe(200);
				expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
				expect(response.body.data).toEqual({ utils_random_string: null });
			});
		});

		describe('defaults to a 32 character string when length is omitted', () => {
			test('GraphQL', async ({ api }) => {
				const response = await requestGraphQL(api.url, true, api.adminToken, {
					mutation: { utils_random_string: true },
				});

				expect(response.statusCode).toBe(200);
				expect(response.body.data.utils_random_string).toHaveLength(32);
			});
		});
	});
});
