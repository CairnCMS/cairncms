import { apiTest as test } from '../../fixtures/environment';
import { describe, expect } from 'vitest';
import request, { requestGraphQL } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

describe('/server', () => {
	describe('GET /ping', () => {
		test('REST and GraphQL', async ({ api }) => {
			// Action
			const response = await request(api.url)
				.get('/server/ping')
				.expect('Content-Type', /text\/html/)
				.expect(200);

			const gqlResponse = await requestGraphQL(api.url, true, null, {
				query: {
					server_ping: true,
				},
			});

			// Assert
			expect(response.text).toBe('pong');
			expect(gqlResponse.body.data.server_ping).toBe('pong');
		});
	});
});
