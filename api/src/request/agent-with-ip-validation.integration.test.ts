import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { factoryEnv, dnsLookupMock } = vi.hoisted(() => ({
	factoryEnv: {} as { [k: string]: any },
	dnsLookupMock: vi.fn(),
}));

vi.mock('../env.js', () => {
	const proxy = new Proxy(
		{},
		{
			get(_target, prop) {
				return factoryEnv[prop as string];
			},
		}
	);

	return {
		default: proxy,
		getEnv: () => proxy,
	};
});

vi.mock('../logger.js', () => ({
	default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('node:dns', async () => {
	const actual = await vi.importActual<typeof import('node:dns')>('node:dns');

	return {
		...actual,
		default: { ...actual, lookup: dnsLookupMock },
		lookup: dnsLookupMock,
	};
});

const agentModule = await import('./agent-with-ip-validation.js');
const ValidatingHttpAgent = agentModule.ValidatingHttpAgent;

let redirectServer: http.Server;
let serverPort: number;
let redirectTargetUrl: string;
const requestLog: string[] = [];

beforeAll(async () => {
	redirectServer = http.createServer((req, res) => {
		requestLog.push(`${req.method} ${req.url}`);

		if (req.url === '/redirect-to-denied') {
			res.writeHead(302, { Location: redirectTargetUrl });
			res.end();
			return;
		}

		if (req.url === '/redirect-to-self-allowed') {
			res.writeHead(302, { Location: '/done' });
			res.end();
			return;
		}

		if (req.url === '/done') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('ok');
			return;
		}

		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolve) => {
		redirectServer.listen(0, '127.0.0.1', () => resolve());
	});

	serverPort = (redirectServer.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise<void>((resolve) => {
		redirectServer.close(() => resolve());
	});
});

beforeEach(() => {
	factoryEnv['PUBLIC_URL'] = 'https://cairncms.example';
	factoryEnv['IMPORT_IP_DENY_LIST'] = [];
	requestLog.length = 0;

	dnsLookupMock.mockReset();

	dnsLookupMock.mockImplementation(async (host: string, opts: unknown, cb: any) => {
		const dns = await vi.importActual<typeof import('node:dns')>('node:dns');
		dns.lookup(host, opts as any, cb);
	});
});

test('IP-literal redirect target on deny-list is blocked BEFORE the TCP SYN', async () => {
	factoryEnv['IMPORT_IP_DENY_LIST'] = ['169.254.169.254'];
	redirectTargetUrl = 'http://169.254.169.254/test';

	const agent = new ValidatingHttpAgent();

	const start = process.hrtime.bigint();

	const result = await new Promise<{ statusCode?: number | undefined; err?: Error }>((resolve) => {
		const req = http.request(
			{ host: '127.0.0.1', port: serverPort, path: '/redirect-to-denied', agent, method: 'GET' },
			(res) => {
				const location = res.headers.location;
				if (!location) return resolve({ statusCode: res.statusCode });

				const followReq = http.request(location, { agent, method: 'GET' }, (followRes) => {
					resolve({ statusCode: followRes.statusCode });
				});

				followReq.on('error', (err) => resolve({ err }));
				followReq.end();
			}
		);

		req.on('error', (err) => resolve({ err }));
		req.end();
	});

	const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

	expect(requestLog).toContain('GET /redirect-to-denied');

	expect(result.err).toBeInstanceOf(Error);
	expect(result.err?.message).toContain('denied IP address');

	expect(elapsedMs).toBeLessThan(500);
});

test('legitimate redirect to a non-listed IP succeeds (regression)', async () => {
	factoryEnv['IMPORT_IP_DENY_LIST'] = ['169.254.169.254'];

	const agent = new ValidatingHttpAgent();

	const result = await new Promise<{ statusCode?: number | undefined; err?: Error | undefined; body?: string }>(
		(resolve) => {
			const req = http.request(
				{ host: '127.0.0.1', port: serverPort, path: '/redirect-to-self-allowed', agent, method: 'GET' },
				(res) => {
					const location = res.headers.location;
					if (!location) return resolve({ statusCode: res.statusCode });

					const followReq = http.request(
						{ host: '127.0.0.1', port: serverPort, path: location, agent, method: 'GET' },
						(followRes) => {
							let body = '';
							followRes.on('data', (chunk: Buffer) => (body += chunk.toString()));
							followRes.on('end', () => resolve({ statusCode: followRes.statusCode, body }));
						}
					);

					followReq.on('error', (err) => resolve({ err }));
					followReq.end();
				}
			);

			req.on('error', (err) => resolve({ err }));
			req.end();
		}
	);

	expect(result.err).toBeUndefined();
	expect(result.statusCode).toBe(200);
	expect(result.body).toBe('ok');
	expect(requestLog).toContain('GET /redirect-to-self-allowed');
	expect(requestLog).toContain('GET /done');
});

test('direct connection to deny-listed IP-literal fails before SYN (no fallback to network)', async () => {
	factoryEnv['IMPORT_IP_DENY_LIST'] = ['169.254.169.254'];

	const agent = new ValidatingHttpAgent();

	const start = process.hrtime.bigint();

	const result = await new Promise<{ err?: Error }>((resolve) => {
		const req = http.request({ host: '169.254.169.254', port: 80, path: '/', agent, method: 'GET' }, () => resolve({}));

		req.on('error', (err) => resolve({ err }));
		req.end();
	});

	const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

	expect(result.err).toBeInstanceOf(Error);
	expect(result.err?.message).toContain('denied IP address');
	expect(elapsedMs).toBeLessThan(500);
});

test('hostname resolving to an allowed IP reaches the server via the agent', async () => {
	factoryEnv['IMPORT_IP_DENY_LIST'] = ['169.254.169.254'];

	dnsLookupMock.mockImplementation((_host: string, _opts: unknown, cb: any) => {
		cb(null, '127.0.0.1', 4);
	});

	const agent = new ValidatingHttpAgent();

	const result = await new Promise<{ statusCode?: number | undefined; body?: string | undefined; err?: Error }>(
		(resolve) => {
			const req = http.request(
				{ host: 'public.example', port: serverPort, path: '/done', agent, method: 'GET' },
				(res) => {
					let body = '';
					res.on('data', (chunk: Buffer) => (body += chunk.toString()));
					res.on('end', () => resolve({ statusCode: res.statusCode, body }));
				}
			);

			req.on('error', (err) => resolve({ err }));
			req.end();
		}
	);

	expect(result.err).toBeUndefined();
	expect(result.statusCode).toBe(200);
	expect(result.body).toBe('ok');
	expect(requestLog).toContain('GET /done');
});

test('hostname resolving to a deny-listed IP fails fast at the lookup boundary', async () => {
	factoryEnv['IMPORT_IP_DENY_LIST'] = ['169.254.169.254'];

	dnsLookupMock.mockImplementation((_host: string, _opts: unknown, cb: any) => {
		cb(null, '169.254.169.254', 4);
	});

	const agent = new ValidatingHttpAgent();

	const start = process.hrtime.bigint();

	const result = await new Promise<{ err?: Error }>((resolve) => {
		const req = http.request({ host: 'attacker.example', port: 80, path: '/', agent, method: 'GET' }, () =>
			resolve({})
		);

		req.on('error', (err) => resolve({ err }));
		req.end();
	});

	const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

	expect(result.err).toBeInstanceOf(Error);
	expect(result.err?.message).toContain('denied IP address');
	expect(elapsedMs).toBeLessThan(500);
});
