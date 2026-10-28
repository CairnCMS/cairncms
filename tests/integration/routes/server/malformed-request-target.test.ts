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

const test = createIdentityTest({
	env: { LOG_STYLE: 'raw', LOG_LEVEL: 'info' },
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

describe('malformed request targets', () => {
	test('an absolute-form target with an invalid host returns 404 without stopping the API', async ({ api }) => {
		const { malformed, healthStatus, logs } = await captureMalformed(api, 'http://[/items/books');

		expect(malformed.status).toBe(404);
		expect(healthStatus).toBe(200);
		expect(logs).not.toContain('http://[');
		expect(unexpectedWarnings(logs)).toEqual([]);
	});

	test('a protocol-relative target with an invalid host returns 404 and redacts its logged URL', async ({ api }) => {
		const { malformed, healthStatus, logs } = await captureMalformed(api, `//[x/items?access_token=${api.adminToken}`);

		expect(malformed.status).toBe(404);
		expect(healthStatus).toBe(200);
		expect(hasRequestUrl(logs, REDACT_TEXT)).toBe(true);
		expect(logs).not.toContain(api.adminToken);
		expect(unexpectedWarnings(logs)).toEqual([]);
	});

	test('a target carrying credentials before an invalid host returns 404 without leaking them', async ({ api }) => {
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
});
