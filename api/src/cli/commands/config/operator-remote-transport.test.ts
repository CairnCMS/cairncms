import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const factoryEnv: { [k: string]: any } = {};

vi.mock('../../../env.js', () => {
	const proxy = new Proxy(
		{},
		{
			get(_target, prop) {
				return factoryEnv[prop as string];
			},
		}
	);

	return { default: proxy, getEnv: () => proxy };
});

vi.mock('../../../logger.js', () => ({
	default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('node:os', () => ({
	default: { networkInterfaces: vi.fn().mockReturnValue({}) },
	networkInterfaces: vi.fn().mockReturnValue({}),
}));

const dnsLookupMock = vi.fn();

vi.mock('node:dns', async () => {
	const actual = await vi.importActual<typeof import('node:dns')>('node:dns');
	return { ...actual, default: { ...actual, lookup: dnsLookupMock }, lookup: dnsLookupMock };
});

const { validateOperatorTargetIp, createOperatorRemoteTransport, DEFAULT_REMOTE_TIMEOUT_MS } = await import(
	'./operator-remote-transport.js'
);

const { validateIPSync } = await import('../../../request/validate-ip.js');
const { makeValidatingLookup } = await import('../../../request/agent-with-ip-validation.js');

const url = 'https://cms.example';

beforeEach(() => {
	factoryEnv['IMPORT_IP_DENY_LIST'] = ['0.0.0.0', '169.254.169.254'];
	dnsLookupMock.mockReset();
	delete process.env['CAIRNCMS_REMOTE_CONFIG_TIMEOUT'];
});

afterEach(() => {
	vi.clearAllMocks();
	delete process.env['CAIRNCMS_REMOTE_CONFIG_TIMEOUT'];
});

describe('validateOperatorTargetIp', () => {
	it('rejects an explicit deny-list entry such as the metadata IP', () => {
		expect(() => validateOperatorTargetIp('169.254.169.254', url)).toThrow(/denied IP address/);
	});

	it('allows loopback and private addresses that the server deny-list would block', () => {
		expect(() => validateOperatorTargetIp('127.0.0.1', url)).not.toThrow();
		expect(() => validateOperatorTargetIp('10.0.0.5', url)).not.toThrow();

		expect(() => validateIPSync('127.0.0.1', url)).toThrow(/denied IP address/);
		expect(() => validateIPSync('10.0.0.5', url)).not.toThrow();
	});
});

describe('operator lookup — anti-rebinding on resolved addresses', () => {
	const lookup = makeValidatingLookup(validateOperatorTargetIp) as any;

	it('rejects a hostname that resolves to the metadata IP', async () => {
		dnsLookupMock.mockImplementation((_h: string, _o: unknown, cb: any) => cb(null, '169.254.169.254', 4));

		const err = await new Promise<Error | null>((resolve) =>
			lookup('probe.example', {}, (e: Error | null) => resolve(e))
		);

		expect(err).toBeInstanceOf(Error);
		expect(err?.message).toContain('denied IP address');
	});

	it('rejects an all-mode result mixing an allowed and a denied address', async () => {
		dnsLookupMock.mockImplementation((_h: string, _o: unknown, cb: any) =>
			cb(null, [
				{ address: '10.0.0.5', family: 4 },
				{ address: '169.254.169.254', family: 4 },
			])
		);

		const err = await new Promise<Error | null>((resolve) =>
			lookup('probe.example', { all: true }, (e: Error | null) => resolve(e))
		);

		expect(err).toBeInstanceOf(Error);
	});

	it('allows a hostname that resolves to loopback', async () => {
		dnsLookupMock.mockImplementation((_h: string, _o: unknown, cb: any) => cb(null, '127.0.0.1', 4));

		const result = await new Promise<{ err: Error | null; address?: string }>((resolve) =>
			lookup('localhost', {}, (err: Error | null, address?: string) => resolve({ err, address }))
		);

		expect(result.err).toBeNull();
		expect(result.address).toBe('127.0.0.1');
	});
});

describe('createOperatorRemoteTransport', () => {
	it('disables environment proxies, refuses redirects, and sets the default timeout when unset', async () => {
		const transport = await createOperatorRemoteTransport();

		expect(transport.defaults.proxy).toBe(false);
		expect(transport.defaults.maxRedirects).toBe(0);
		expect(transport.defaults.timeout).toBe(DEFAULT_REMOTE_TIMEOUT_MS);
	});

	it('identifies itself with the CLI product token', async () => {
		const transport = await createOperatorRemoteTransport();

		expect(transport.defaults.headers['User-Agent']).toMatch(/^cairncms-cli\/\d+\.\d+\.\d+/);
	});

	it('honors a positive numeric timeout override from the environment', async () => {
		process.env['CAIRNCMS_REMOTE_CONFIG_TIMEOUT'] = '5000';

		const transport = await createOperatorRemoteTransport();
		expect(transport.defaults.timeout).toBe(5000);
	});

	it('accepts a duration-form timeout override', async () => {
		process.env['CAIRNCMS_REMOTE_CONFIG_TIMEOUT'] = '30s';

		const transport = await createOperatorRemoteTransport();
		expect(transport.defaults.timeout).toBe(30_000);
	});

	it.each(['abc', '0', '-5', '1.5e3'])('fails at exit 2 for an invalid timeout %j', async (raw) => {
		process.env['CAIRNCMS_REMOTE_CONFIG_TIMEOUT'] = raw;

		await expect(createOperatorRemoteTransport()).rejects.toMatchObject({ exitCode: 2 });
	});
});
