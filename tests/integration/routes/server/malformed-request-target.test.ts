import { describe, expect } from 'vitest';
import request from '../../fixtures/request';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { TestLogger } from '../../fixtures/test-logger.mjs';
import {
	ERROR_SINK_ENDPOINT,
	ERROR_SINK_FAILURE,
	records,
	type RawResponse,
	sendRawTarget,
	unexpectedWarnings,
} from '../../fixtures/raw-request';

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
});
