import http from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { describe, expect, test, vi } from 'vitest';
import { REDACT_TEXT } from './constants.js';

vi.doMock('./env', async () => {
	const MOCK_ENV = { LOG_LEVEL: 'info', LOG_STYLE: 'pretty' };

	return {
		default: MOCK_ENV,
		getEnv: () => MOCK_ENV,
	};
});

const { httpLoggerOptions } = await import('./logger.js');

// Drive the real pino-http response path in memory: a ServerResponse over an unconnected socket
// (no bind/listen), the middleware, then a synchronous 'finish' that emits the captured log.
function captureResponseLog(applyHeaders: (res: http.ServerResponse) => void): any {
	const logs: any[] = [];

	const stream = new Writable({
		write(chunk, _encoding, callback) {
			logs.push(JSON.parse(chunk.toString()));
			callback();
		},
	});

	// Drop the pretty-print transport so the output lands on the test stream.
	const middleware = pinoHttp({ logger: pino({ ...httpLoggerOptions, transport: undefined }, stream) });

	const socket = new Socket();
	const req = new http.IncomingMessage(socket);
	req.method = 'GET';
	req.url = '/';
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
		const log = captureResponseLog((res) => {
			res.setHeader('set-cookie', 'cairncms_refresh_token=test-refresh-token-value; HttpOnly');
			res.setHeader('content-type', 'application/json');
		});

		expect(log.res.headers['set-cookie']).toBe(REDACT_TEXT);
		expect(log.res.headers['content-type']).toBe('application/json');
	});
});
