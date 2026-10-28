import { describe, expect } from 'vitest';
import request from '../../fixtures/request';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { TestLogger } from '../../fixtures/test-logger.mjs';
import { records, sendRawTarget } from '../../fixtures/raw-request';

const NOT_FOUND_MARKER = `doesn't exist.`;

const test = createIdentityTest({ env: { LOG_STYLE: 'raw', LOG_LEVEL: 'debug' } });

initializeFixtures();

function hasNotFoundRecord(logs: string): boolean {
	for (const record of records(logs)) {
		if (typeof record['msg'] === 'string' && record['msg'].includes(NOT_FOUND_MARKER)) return true;
	}

	return false;
}

describe('malformed request target diagnostics at debug level', () => {
	test('a credential-bearing target does not leak into the 404 debug log or response', async ({ api }) => {
		const password = 's3cretpw';

		const logger = new TestLogger(api.child, NOT_FOUND_MARKER, undefined, {
			completeWhen: (logs: string) => hasNotFoundRecord(logs),
		});

		let logs = '';

		try {
			const malformed = await sendRawTarget(api.backendUrl, `///alice:${password}@[x/items`);
			expect(malformed.status).toBe(404);
			expect(malformed.raw).not.toContain(password);

			logs = await logger.getLogs();
		} finally {
			logger.cleanup();
		}

		expect(hasNotFoundRecord(logs)).toBe(true);
		expect(logs).not.toContain(password);

		const health = await request(api.url)
			.get('/server/health')
			.set('Authorization', `Bearer ${USER.APP_ACCESS!.TOKEN}`);

		expect(health.statusCode).toBe(200);
	});
});
