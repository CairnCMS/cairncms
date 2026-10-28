import { describe, expect } from 'vitest';
import request from '../../fixtures/request';
import { createIdentityTest } from '../../fixtures/identities';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { TestLogger } from '../../fixtures/test-logger.mjs';
import { ERROR_SINK_ENDPOINT, ERROR_SINK_FAILURE, records, unexpectedWarnings } from '../../fixtures/raw-request';

// A root-relative PUBLIC_URL (the default, no absoluteOrigin) is what drives the Referer-parsing
// branch of shouldSkipCache, so this fixture exercises the path an absolute origin would bypass.
const test = createIdentityTest({
	env: {
		LOG_STYLE: 'raw',
		LOG_LEVEL: 'info',
		CACHE_ENABLED: 'true',
		CACHE_AUTO_PURGE: 'true',
		CACHE_STORE: 'memory',
	},
	extensions: ['cairncms-extension-error-sink'],
});

initializeFixtures();

describe('malformed Referer with caching enabled', () => {
	test('a malformed Referer does not turn a cacheable request into a server error', async ({ api }) => {
		const logger = new TestLogger(api.child, ERROR_SINK_ENDPOINT, undefined, {
			completeWhen: (logs: string) =>
				records(logs).some((record) => record['err']?.message?.includes(ERROR_SINK_FAILURE)),
		});

		let logs = '';

		try {
			const response = await request(api.url)
				.get('/roles')
				.set('Authorization', `Bearer ${api.adminToken}`)
				.set('Referer', 'http://[');

			expect(response.statusCode).toBe(200);

			await request(api.url)
				.post(ERROR_SINK_ENDPOINT)
				.set('Authorization', `Bearer ${api.adminToken}`)
				.send({})
				.expect(500);

			logs = await logger.getLogs();
		} finally {
			logger.cleanup();
		}

		expect(unexpectedWarnings(logs)).toEqual([]);
	});
});
