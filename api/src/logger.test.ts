import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { REDACT_TEXT } from './constants.js';

const REFRESH_TOKEN_COOKIE_NAME = 'cairncms_refresh_token';

vi.doMock('./env', async () => {
	const MOCK_ENV = {
		AUTH_PROVIDERS: 'ranger,monospace',
		AUTH_RANGER_DRIVER: 'oauth2',
		AUTH_MONOSPACE_DRIVER: 'openid',
		REFRESH_TOKEN_COOKIE_NAME,
		LOG_LEVEL: 'info',
		LOG_STYLE: 'raw',
	};

	return {
		default: MOCK_ENV,
		getEnv: () => MOCK_ENV,
	};
});

const { httpLoggerOptions, createExpressLogger } = await import('./logger.js');

const logOutput = vi.fn();

let stream: Writable;

beforeEach(() => {
	stream = new Writable({
		write(chunk) {
			logOutput(JSON.parse(chunk.toString()));
		},
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('req.query.access_token', () => {
	test('Should redact access_token query parameter (GHSA-vw58-ph65-6rxp)', () => {
		const instance = pino(httpLoggerOptions, stream);

		instance.info({
			req: {
				query: {
					access_token: 'test-access-token-value',
				},
			},
		});

		expect(logOutput.mock.calls[0]![0]).toMatchObject({
			req: {
				query: {
					access_token: REDACT_TEXT,
				},
			},
		});
	});

	test('Should leave non-sensitive query parameters unchanged', () => {
		const instance = pino(httpLoggerOptions, stream);

		instance.info({
			req: {
				query: {
					fields: 'id,name',
				},
			},
		});

		expect(logOutput.mock.calls[0]![0]).toMatchObject({
			req: {
				query: {
					fields: 'id,name',
				},
			},
		});
	});

	test('Should redact access_token while preserving other query parameters in the same payload', () => {
		const instance = pino(httpLoggerOptions, stream);

		instance.info({
			req: {
				query: {
					access_token: 'test-access-token-value',
					fields: 'id,name',
				},
			},
		});

		expect(logOutput.mock.calls[0]![0]).toMatchObject({
			req: {
				query: {
					access_token: REDACT_TEXT,
					fields: 'id,name',
				},
			},
		});
	});
});

describe('req.headers.authorization', () => {
	test('Should redact bearer token in Authorization header', () => {
		const instance = pino(httpLoggerOptions, stream);

		instance.info({
			req: {
				headers: {
					authorization: `Bearer test-access-token-value`,
				},
			},
		});

		expect(logOutput.mock.calls[0]![0]).toMatchObject({
			req: {
				headers: {
					authorization: REDACT_TEXT,
				},
			},
		});
	});
});

describe('req.headers.cookie', () => {
	test('Should redact refresh token when there is only one entry', () => {
		const instance = pino(httpLoggerOptions, stream);

		instance.info({
			req: {
				headers: {
					cookie: `${REFRESH_TOKEN_COOKIE_NAME}=test-refresh-token-value`,
				},
			},
		});

		expect(logOutput.mock.calls[0]![0]).toMatchObject({
			req: {
				headers: {
					cookie: REDACT_TEXT,
				},
			},
		});
	});

	test('Should redact refresh token with multiple entries', () => {
		const instance = pino(httpLoggerOptions, stream);

		instance.info({
			req: {
				headers: {
					cookie: `custom_test_cookie=custom_test_value; access_token=test-access-token-value; oauth2.ranger=test-oauth2-value; openid.monospace=test-openid-value; ${REFRESH_TOKEN_COOKIE_NAME}=test-refresh-token-value`,
				},
			},
		});

		expect(logOutput.mock.calls[0]![0]).toMatchObject({
			req: {
				headers: {
					cookie: REDACT_TEXT,
				},
			},
		});
	});
});

describe('res.headers', () => {
	test('Should redact refresh token when there is only one entry', () => {
		const instance = pino(httpLoggerOptions, stream);

		instance.info({
			res: {
				headers: {
					'set-cookie': `${REFRESH_TOKEN_COOKIE_NAME}=test-refresh-token-value; Max-Age=604800; Path=/; Expires=Tue, 14 Feb 2023 12:00:00 GMT; HttpOnly; SameSite=Lax`,
				},
			},
		});

		expect(logOutput.mock.calls[0]![0]).toMatchObject({
			res: {
				headers: {
					'set-cookie': REDACT_TEXT,
				},
			},
		});
	});

	test('Should redact refresh token with multiple entries', () => {
		const instance = pino(httpLoggerOptions, stream);

		instance.info({
			res: {
				headers: {
					'set-cookie': [
						`access_token=test-access-token-value; Max-Age=604800; Path=/; Expires=Tue, 14 Feb 2023 12:00:00 GMT; HttpOnly; SameSite=Lax`,
						`oauth2.ranger=test-oauth2-value; Max-Age=604800; Path=/; Expires=Tue, 14 Feb 2023 12:00:00 GMT; HttpOnly; SameSite=Lax`,
						`openid.monospace=test-openid-value; Max-Age=604800; Path=/; Expires=Tue, 14 Feb 2023 12:00:00 GMT; HttpOnly; SameSite=Lax`,
						`${REFRESH_TOKEN_COOKIE_NAME}=test-refresh-token-value; Max-Age=604800; Path=/; Expires=Tue, 14 Feb 2023 12:00:00 GMT; HttpOnly; SameSite=Lax`,
					],
				},
			},
		});

		expect(logOutput.mock.calls[0]![0]).toMatchObject({
			res: {
				headers: {
					'set-cookie': REDACT_TEXT,
				},
			},
		});
	});
});

describe('createExpressLogger request URL redaction', () => {
	function logRequestUrl(originalUrl: string): { url: unknown; raw: string } {
		const records: { raw: string }[] = [];

		const capture = new Writable({
			write(chunk, _encoding, callback) {
				records.push({ raw: chunk.toString() });
				callback();
			},
		});

		const middleware = createExpressLogger(pino({ level: 'info' }, capture)) as (
			req: unknown,
			res: unknown,
			next: () => void
		) => void;

		const req = { method: 'GET', originalUrl, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
		const res = Object.assign(new EventEmitter(), { statusCode: 200, getHeaders: () => ({}) });

		let nextCalled = false;

		middleware(req, res, () => {
			nextCalled = true;
		});

		res.emit('finish');

		expect(nextCalled).toBe(true);
		const raw = records.map((record) => record.raw).join('');
		return { url: JSON.parse(raw).req.url, raw };
	}

	test('replaces an unparseable URL carrying a token with the redaction marker', () => {
		const { url, raw } = logRequestUrl('//[x/items?access_token=test-access-token-value');

		expect(url).toBe(REDACT_TEXT);
		expect(raw).not.toContain('test-access-token-value');
	});

	test('replaces an unparseable URL carrying credentials with the redaction marker', () => {
		const { url, raw } = logRequestUrl('//alice:test-password@[x/items?access_token=test-access-token-value');

		expect(url).toBe(REDACT_TEXT);
		expect(raw).not.toContain('test-password');
		expect(raw).not.toContain('test-access-token-value');
	});

	test('redacts the access token while keeping other query parameters on a parseable URL', () => {
		const { url } = logRequestUrl('/items?access_token=test-access-token-value&limit=1');

		expect(url).toBe(`/items?access_token=${REDACT_TEXT}&limit=1`);
	});

	test('drops userinfo from a parseable protocol-relative URL', () => {
		const { url } = logRequestUrl('//alice:test-password@x/items');

		expect(url).toBe('/items');
	});
});
