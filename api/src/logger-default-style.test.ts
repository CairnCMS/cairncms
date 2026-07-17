import http from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, test, vi } from 'vitest';
import { REDACT_TEXT } from './constants.js';

vi.doMock('./env', async () => {
	const MOCK_ENV = { LOG_LEVEL: 'info', LOG_STYLE: 'pretty' };

	return {
		default: MOCK_ENV,
		getEnv: () => MOCK_ENV,
	};
});

const { httpLoggerOptions, createExpressLogger } = await import('./logger.js');

function captureLog(options: { url?: string; applyHeaders?: (res: http.ServerResponse) => void } = {}): any {
	const { url = '/', applyHeaders = () => undefined } = options;
	const logs: any[] = [];

	const stream = new Writable({
		write(chunk, _encoding, callback) {
			logs.push(JSON.parse(chunk.toString()));
			callback();
		},
	});

	// The pretty-print transport is dropped so the log lands on the capture stream instead.
	const middleware = createExpressLogger(pino({ ...httpLoggerOptions, transport: undefined }, stream));

	// An unconnected socket drives pino-http without binding a network port.
	const socket = new Socket();
	const req = new http.IncomingMessage(socket);
	req.method = 'GET';
	req.url = url;
	req.headers = {};

	const res = new http.ServerResponse(req);
	middleware(req, res, () => undefined);
	applyHeaders(res);
	res.statusCode = 200;
	res.emit('finish');
	socket.destroy();

	return logs.find((entry) => entry['res']);
}

describe('default log style redaction through the real pino-http path', () => {
	test('censors set-cookie in the response headers while keeping other headers', () => {
		const log = captureLog({
			applyHeaders: (res) => {
				res.setHeader('set-cookie', 'cairncms_refresh_token=test-refresh-token-value; HttpOnly');
				res.setHeader('content-type', 'application/json');
			},
		});

		expect(log.res.headers['set-cookie']).toBe(REDACT_TEXT);
		expect(log.res.headers['content-type']).toBe('application/json');
	});

	test('redacts access_token in the request url while keeping other query parameters', () => {
		const log = captureLog({ url: '/items/thing?access_token=test-access-token-value&fields=id' });

		expect(JSON.stringify(log)).not.toContain('test-access-token-value');
		expect(log.req.url).toContain(`access_token=${REDACT_TEXT}`);
		expect(log.req.url).toContain('fields=id');
	});
});
