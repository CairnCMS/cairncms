import { describe, expect } from 'vitest';
import request from '../../fixtures/request';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { TestLogger } from '../../fixtures/test-logger.mjs';
import {
	ERROR_SINK_ENDPOINT,
	ERROR_SINK_FAILURE,
	hasRequestUrl,
	records,
	type RawResponse,
	sendRawTarget,
	unexpectedWarnings,
} from '../../fixtures/raw-request';

const REDACT_TEXT = '--redact--';
const cacheStatusHeader = 'x-cache-status';

const test = createIdentityTest({
	absoluteOrigin: true,
	env: {
		LOG_STYLE: 'raw',
		LOG_LEVEL: 'info',
		CACHE_ENABLED: 'true',
		CACHE_AUTO_PURGE: 'true',
		CACHE_STORE: 'memory',
		CACHE_STATUS_HEADER: cacheStatusHeader,
		CACHE_NAMESPACE: 'cairncms-cache-malformed-target',
	},
	extensions: ['cairncms-extension-error-sink'],
});

initializeFixtures();

// The HTTP and application loggers flush independently, so capture drains until an error record from
// a trailing error-sink request proves the application stream has passed the malformed request.
async function captureMalformed(
	api: { backendUrl: string; url: string; adminToken: string; child: import('node:child_process').ChildProcess },
	target: string,
	headers: Record<string, string> = {}
): Promise<{ malformed: RawResponse; healthStatus: number; logs: string }> {
	const logger = new TestLogger(api.child, ERROR_SINK_ENDPOINT, undefined, {
		completeWhen: (logs: string) =>
			records(logs).some((record) => record['err']?.message?.includes(ERROR_SINK_FAILURE)),
	});

	try {
		const malformed = await sendRawTarget(api.backendUrl, target, headers);

		const health = await request(api.url)
			.get('/server/health')
			.set('Authorization', `Bearer ${USER.APP_ACCESS!.TOKEN}`);

		await request(api.url)
			.post(ERROR_SINK_ENDPOINT)
			.set('Authorization', `Bearer ${api.adminToken}`)
			.send({})
			.expect(500);

		const logs = await logger.getLogs();
		return { malformed, healthStatus: health.statusCode, logs };
	} finally {
		logger.cleanup();
	}
}

describe('malformed request targets with caching enabled', () => {
	test('a credential-bearing target returns 404 without the Data Studio Referer', async ({ api }) => {
		const password = 's3cretpw';

		const { malformed, healthStatus, logs } = await captureMalformed(
			api,
			`//alice:${password}@[x/items?access_token=${api.adminToken}`
		);

		expect(malformed.status).toBe(404);
		expect(healthStatus).toBe(200);
		expect(hasRequestUrl(logs, REDACT_TEXT)).toBe(true);
		expect(logs).not.toContain(password);
		expect(logs).not.toContain(api.adminToken);
		expect(unexpectedWarnings(logs)).toEqual([]);
	});

	test('a credential-bearing target returns 404 with an admin-app Referer and auto-purge on', async ({ api }) => {
		const password = 's3cretpw';

		const { malformed, healthStatus, logs } = await captureMalformed(
			api,
			`//alice:${password}@[x/items?access_token=${api.adminToken}`,
			{ Referer: `${api.url}/admin/content` }
		);

		expect(malformed.status).toBe(404);
		expect(healthStatus).toBe(200);
		expect(hasRequestUrl(logs, REDACT_TEXT)).toBe(true);
		expect(logs).not.toContain(password);
		expect(logs).not.toContain(api.adminToken);
		expect(unexpectedWarnings(logs)).toEqual([]);
	});

	test('an ordinary request still caches as MISS then HIT with an admin-app Referer', async ({ api }) => {
		const referer = `${api.url}/admin/content`;

		const miss = await request(api.url)
			.get('/roles')
			.set('Authorization', `Bearer ${api.adminToken}`)
			.set('Referer', referer);

		expect(miss.statusCode).toBe(200);
		expect(miss.headers[cacheStatusHeader]).toBe('MISS');

		const hit = await request(api.url)
			.get('/roles')
			.set('Authorization', `Bearer ${api.adminToken}`)
			.set('Referer', referer);

		expect(hit.statusCode).toBe(200);
		expect(hit.headers[cacheStatusHeader]).toBe('HIT');
	});
});
