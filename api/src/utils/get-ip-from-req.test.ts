import express from 'express';
import type { IncomingMessage, Server } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getEnv } from '../env.js';
import logger from '../logger.js';
import { getIPForRequest, getIPFromReq } from './get-ip-from-req.js';
import { getTrustProxyFn } from './resolve-client-ip.js';

const trustAll = () => true;
const trustNone = () => false;

function makeReq(options: {
	peer?: string;
	xff?: string;
	headers?: Record<string, string | string[]>;
	trust?: unknown;
}): any {
	const headers: Record<string, string | string[]> = { ...options.headers };
	if (options.xff !== undefined) headers['x-forwarded-for'] = options.xff;

	return {
		app: { get: (key: string) => (key === 'trust proxy fn' ? options.trust : undefined) },
		socket: { remoteAddress: options.peer },
		headers,
	};
}

describe('getIPFromReq', () => {
	let original: unknown;

	beforeEach(() => {
		original = getEnv()['IP_CUSTOM_HEADER'];
	});

	afterEach(() => {
		getEnv()['IP_CUSTOM_HEADER'] = original;
		vi.restoreAllMocks();
	});

	test('a trusted proxy chain resolves the client, not the proxy', () => {
		getEnv()['IP_CUSTOM_HEADER'] = false;
		const req = makeReq({ peer: '10.0.0.1', xff: '198.51.100.7', trust: trustAll });
		expect(getIPFromReq(req)).toBe('198.51.100.7');
	});

	test('an untrusted peer cannot inject a forwarded address', () => {
		getEnv()['IP_CUSTOM_HEADER'] = false;
		const req = makeReq({ peer: '203.0.113.5', xff: '198.51.100.7', trust: trustNone });
		expect(getIPFromReq(req)).toBe('203.0.113.5');
	});

	test('a trusted peer single valid custom header is honored', () => {
		getEnv()['IP_CUSTOM_HEADER'] = 'X-Real-IP';
		const req = makeReq({ peer: '10.0.0.1', headers: { 'x-real-ip': '198.51.100.7' }, trust: trustAll });
		expect(getIPFromReq(req)).toBe('198.51.100.7');
	});

	test('an untrusted peer custom header is ignored', () => {
		getEnv()['IP_CUSTOM_HEADER'] = 'X-Real-IP';
		const req = makeReq({ peer: '203.0.113.5', headers: { 'x-real-ip': '10.9.9.9' }, trust: trustNone });
		expect(getIPFromReq(req)).toBe('203.0.113.5');
	});

	test('a missing custom header retains the standard IP', () => {
		getEnv()['IP_CUSTOM_HEADER'] = 'X-Real-IP';
		const req = makeReq({ peer: '10.0.0.1', trust: trustAll });
		expect(getIPFromReq(req)).toBe('10.0.0.1');
	});

	test('a multi-valued custom header retains the standard IP', () => {
		getEnv()['IP_CUSTOM_HEADER'] = 'X-Real-IP';

		const req = makeReq({
			peer: '10.0.0.1',
			headers: { 'x-real-ip': ['198.51.100.7', '203.0.113.1'] },
			trust: trustAll,
		});

		expect(getIPFromReq(req)).toBe('10.0.0.1');
	});

	test('an invalid custom header value retains the standard IP', () => {
		getEnv()['IP_CUSTOM_HEADER'] = 'X-Real-IP';
		const req = makeReq({ peer: '10.0.0.1', headers: { 'x-real-ip': 'not-an-ip' }, trust: trustAll });
		expect(getIPFromReq(req)).toBe('10.0.0.1');
	});

	test('a non-string custom header setting is treated as disabled', () => {
		getEnv()['IP_CUSTOM_HEADER'] = true as never;
		const req = makeReq({ peer: '10.0.0.1', headers: { 'x-real-ip': '198.51.100.7' }, trust: trustAll });
		expect(getIPFromReq(req)).toBe('10.0.0.1');
	});

	test('a dotted IPv4-mapped IPv6 address is canonicalized to one key', () => {
		getEnv()['IP_CUSTOM_HEADER'] = false;
		const req = makeReq({ peer: '::ffff:192.0.2.10', trust: trustNone });
		expect(getIPFromReq(req)).toBe('192.0.2.10');
	});

	test('a compressed IPv4-mapped IPv6 address is canonicalized to the same key', () => {
		getEnv()['IP_CUSTOM_HEADER'] = false;
		const req = makeReq({ peer: '::ffff:c000:20a', trust: trustNone });
		expect(getIPFromReq(req)).toBe('192.0.2.10');
	});

	test('a fully expanded IPv4-mapped IPv6 address is canonicalized to the same key', () => {
		getEnv()['IP_CUSTOM_HEADER'] = false;
		const req = makeReq({ peer: '0:0:0:0:0:ffff:192.0.2.10', trust: trustNone });
		expect(getIPFromReq(req)).toBe('192.0.2.10');
	});

	test('a rejected custom header produces no log', () => {
		getEnv()['IP_CUSTOM_HEADER'] = 'X-Real-IP';
		const warn = vi.spyOn(logger, 'warn');
		const req = makeReq({ peer: '203.0.113.5', headers: { 'x-real-ip': 'not-an-ip' }, trust: trustAll });
		getIPFromReq(req);
		expect(warn).not.toHaveBeenCalled();
	});

	test('the accessor fails closed when the trust function is absent', () => {
		getEnv()['IP_CUSTOM_HEADER'] = false;
		const req = makeReq({ peer: '10.0.0.1', trust: undefined });
		expect(() => getIPFromReq(req)).toThrow();
	});

	test('the accessor fails closed when the trust setting is not a function', () => {
		getEnv()['IP_CUSTOM_HEADER'] = false;
		const req = makeReq({ peer: '10.0.0.1', trust: 'nope' });
		expect(() => getIPFromReq(req)).toThrow();
	});
});

describe('getIPForRequest', () => {
	let original: unknown;

	beforeEach(() => {
		original = getEnv()['IP_CUSTOM_HEADER'];
		getEnv()['IP_CUSTOM_HEADER'] = false;
	});

	afterEach(() => {
		getEnv()['IP_CUSTOM_HEADER'] = original;
	});

	function rawReq(peer: string, xff?: string): IncomingMessage {
		const headers: Record<string, string> = {};
		if (xff !== undefined) headers['x-forwarded-for'] = xff;
		return { socket: { remoteAddress: peer }, headers } as unknown as IncomingMessage;
	}

	test('resolves a raw IncomingMessage that has no app property', () => {
		const app = express();
		app.set('trust proxy', true);
		expect(getIPForRequest(app, rawReq('10.0.0.1', '198.51.100.7'))).toBe('198.51.100.7');
	});

	test('an untrusted peer on a raw request cannot inject a forwarded address', () => {
		const app = express();
		app.set('trust proxy', false);
		expect(getIPForRequest(app, rawReq('203.0.113.5', '198.51.100.7'))).toBe('203.0.113.5');
	});
});

describe('getIPFromReq wired through Express', () => {
	let original: unknown;
	const servers: Server[] = [];

	beforeEach(() => {
		original = getEnv()['IP_CUSTOM_HEADER'];
		getEnv()['IP_CUSTOM_HEADER'] = false;
	});

	afterEach(async () => {
		getEnv()['IP_CUSTOM_HEADER'] = original;
		await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	});

	function serve(trust: unknown): Server {
		const app = express();
		app.set('trust proxy', trust);
		app.get('/', (req, res) => res.send(getIPFromReq(req)));
		const server = app.listen(0, '127.0.0.1');
		servers.push(server);
		return server;
	}

	test('the accessor returns the predicate Express compiled', () => {
		const app = express();
		app.set('trust proxy', false);
		expect(getTrustProxyFn(app)).toBe(app.get('trust proxy fn'));
	});

	test('trust proxy false resolves the socket peer and ignores a forged X-Forwarded-For', async () => {
		const res = await request(serve(false)).get('/').set('X-Forwarded-For', '1.2.3.4');
		expect(res.status).toBe(200);
		expect(res.text).toBe('127.0.0.1');
	});

	test('a trusted loopback proxy honors X-Forwarded-For', async () => {
		const res = await request(serve('loopback')).get('/').set('X-Forwarded-For', '1.2.3.4');
		expect(res.status).toBe(200);
		expect(res.text).toBe('1.2.3.4');
	});

	test('a forged custom header from an untrusted peer is ignored', async () => {
		getEnv()['IP_CUSTOM_HEADER'] = 'X-Real-IP';
		const res = await request(serve(false)).get('/').set('X-Real-IP', '9.9.9.9');
		expect(res.status).toBe(200);
		expect(res.text).toBe('127.0.0.1');
	});

	test('a custom header from a trusted loopback peer is honored', async () => {
		getEnv()['IP_CUSTOM_HEADER'] = 'X-Real-IP';
		const res = await request(serve('loopback')).get('/').set('X-Real-IP', '9.9.9.9');
		expect(res.status).toBe(200);
		expect(res.text).toBe('9.9.9.9');
	});

	test('the configured IP_TRUST_PROXY default ignores a forged X-Forwarded-For', async () => {
		const res = await request(serve(getEnv()['IP_TRUST_PROXY'])).get('/').set('X-Forwarded-For', '1.2.3.4');
		expect(res.status).toBe(200);
		expect(res.text).toBe('127.0.0.1');
	});
});
