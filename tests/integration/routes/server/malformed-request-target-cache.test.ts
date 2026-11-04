import { describe, expect } from 'vitest';
import request, { setupRequest } from '../../fixtures/request';
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

const cacheStatusOf = (raw: string): string | null =>
	raw.match(new RegExp(`^${cacheStatusHeader}:\\s*(\\S+)`, 'im'))?.[1] ?? null;

const userAliases = (password: string) => [
	'/users\\me',
	`//alice:${password}@host/users/me`,
	'/users\\me#frag',
	`//alice:${password}@host/users/me#frag`,
];

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

	test('aliases of a cached path are never served its entry', async ({ api }) => {
		const password = 's3cretpw';
		const auth = { Authorization: `Bearer ${api.adminToken}` };

		const miss = await request(api.url).get('/users/me').set(auth);
		expect(miss.statusCode).toBe(200);
		expect(miss.headers[cacheStatusHeader]).toBe('MISS');

		const hit = await request(api.url).get('/users/me').set(auth);
		expect(hit.statusCode).toBe(200);
		expect(hit.headers[cacheStatusHeader]).toBe('HIT');

		for (const alias of userAliases(password)) {
			const { malformed, healthStatus, logs } = await captureMalformed(api, alias, auth);

			expect(malformed.status, alias).toBe(404);
			expect(cacheStatusOf(malformed.raw), alias).toBe('MISS');
			expect(malformed.raw, alias).not.toContain(miss.body.data.email);
			expect(healthStatus).toBe(200);
			expect(logs).not.toContain(password);
			expect(logs).not.toContain(api.adminToken);
			expect(unexpectedWarnings(logs)).toEqual([]);
		}
	});

	test('another user is never served an entry the admin warmed, through any alias', async ({ api }) => {
		const warm = await request(api.url).get('/users/me').set('Authorization', `Bearer ${api.adminToken}`);
		expect(warm.statusCode).toBe(200);
		const adminEmail = warm.body.data.email;

		for (const alias of userAliases('s3cretpw')) {
			const response = await sendRawTarget(api.backendUrl, alias, {
				Authorization: `Bearer ${USER.APP_ACCESS!.TOKEN}`,
			});

			expect(response.status, alias).toBe(404);
			expect(response.raw, alias).not.toContain(adminEmail);
		}
	});

	test('a misrouted alias does not write its response under the path it resembles', async ({ api }) => {
		const auth = { Authorization: `Bearer ${api.adminToken}` };

		const created = await setupRequest(api.url)
			.post('/collections')
			.set(auth)
			.send({
				collection: 'items',
				meta: {},
				schema: {},
				fields: [
					{
						field: 'id',
						type: 'string',
						meta: { hidden: false, readonly: false, interface: 'input' },
						schema: { is_primary_key: true, length: 255, has_auto_increment: false },
					},
				],
			});

		expect(created.statusCode).toBe(200);

		const item = await setupRequest(api.url).post('/items/items').set(auth).send({ id: 'k' });
		expect(item.statusCode).toBe(200);

		const misrouted = await sendRawTarget(api.backendUrl, '//:@h/items/k#frag', auth);
		expect(misrouted.status).toBe(200);
		expect(misrouted.raw).toContain('"id":"k"');
		expect(cacheStatusOf(misrouted.raw)).toBe('MISS');

		const list = await request(api.url).get('/items/k').set(auth);
		expect(list.headers[cacheStatusHeader]).toBe('MISS');
		expect(list.statusCode).toBe(403);
		expect(JSON.stringify(list.body)).not.toContain('"id":"k"');
	});
});
