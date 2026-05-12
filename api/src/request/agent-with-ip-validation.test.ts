import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const factoryEnv: { [k: string]: any } = {};

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

vi.mock('node:os', () => ({
	default: { networkInterfaces: vi.fn().mockReturnValue({}) },
	networkInterfaces: vi.fn().mockReturnValue({}),
}));

const dnsLookupMock = vi.fn();

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
const ValidatingHttpsAgent = agentModule.ValidatingHttpsAgent;
const validatingLookup = agentModule.validatingLookup as any;
const preValidateIpLiteral = agentModule.preValidateIpLiteral;

beforeEach(() => {
	factoryEnv['PUBLIC_URL'] = 'https://cairncms.example';
	factoryEnv['IMPORT_IP_DENY_LIST'] = ['169.254.169.254'];
	dnsLookupMock.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('validatingLookup — DNS resolution + validation', () => {
	test('reports the resolved IP back to the caller when validation passes', async () => {
		dnsLookupMock.mockImplementation((_host: string, _opts: unknown, cb: any) => {
			cb(null, '203.0.113.1', 4);
		});

		const result = await new Promise<{ err: Error | null; address?: string | undefined; family?: number | undefined }>(
			(resolve) => {
				validatingLookup('public.example', {}, (err: Error | null, address?: string, family?: number) => {
					resolve({ err, address, family });
				});
			}
		);

		expect(result.err).toBeNull();
		expect(result.address).toBe('203.0.113.1');
		expect(result.family).toBe(4);
	});

	test('reports a validation error when the resolved IP is on the deny-list', async () => {
		dnsLookupMock.mockImplementation((_host: string, _opts: unknown, cb: any) => {
			cb(null, '169.254.169.254', 4);
		});

		const result = await new Promise<{ err: Error | null }>((resolve) => {
			validatingLookup('attacker.example', {}, (err: Error | null) => resolve({ err }));
		});

		expect(result.err).toBeInstanceOf(Error);
		expect(result.err?.message).toContain('denied IP address');
	});

	test('reports DNS errors back to the caller', async () => {
		const dnsErr = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });

		dnsLookupMock.mockImplementation((_host: string, _opts: unknown, cb: any) => {
			cb(dnsErr);
		});

		const result = await new Promise<{ err: Error | null }>((resolve) => {
			validatingLookup('does-not-exist.example', {}, (err: Error | null) => resolve({ err }));
		});

		expect(result.err).toBe(dnsErr);
	});

	test('handles the two-arg signature (hostname, callback)', async () => {
		dnsLookupMock.mockImplementation((_host: string, _opts: unknown, cb: any) => {
			cb(null, '203.0.113.1', 4);
		});

		const result = await new Promise<{ err: Error | null; address?: string | undefined }>((resolve) => {
			validatingLookup('public.example', (err: Error | null, address?: string) => resolve({ err, address }));
		});

		expect(result.err).toBeNull();
		expect(result.address).toBe('203.0.113.1');
	});

	test('validates IPv4-mapped IPv6 forms against native IPv4 deny-list entries (advisory #9 regression guard)', async () => {
		dnsLookupMock.mockImplementation((_host: string, _opts: unknown, cb: any) => {
			cb(null, '::ffff:169.254.169.254', 6);
		});

		const result = await new Promise<{ err: Error | null }>((resolve) => {
			validatingLookup('mapped-attacker.example', {}, (err: Error | null) => resolve({ err }));
		});

		expect(result.err).toBeInstanceOf(Error);
		expect(result.err?.message).toContain('denied IP address');
	});

	test('rejects all-mode lookup when any address in the array is on the deny-list', async () => {
		dnsLookupMock.mockImplementation((_host: string, _opts: unknown, cb: any) => {
			cb(null, [
				{ address: '203.0.113.1', family: 4 },
				{ address: '169.254.169.254', family: 4 },
			]);
		});

		const result = await new Promise<{ err: Error | null }>((resolve) => {
			validatingLookup('attacker.example', { all: true } as any, (err: Error | null) => resolve({ err }));
		});

		expect(result.err).toBeInstanceOf(Error);
		expect(result.err?.message).toContain('denied IP address');
	});

	test('passes all-mode lookup when every address in the array is allowed', async () => {
		dnsLookupMock.mockImplementation((_host: string, _opts: unknown, cb: any) => {
			cb(null, [
				{ address: '203.0.113.1', family: 4 },
				{ address: '203.0.113.2', family: 4 },
			]);
		});

		const result = await new Promise<{ err: Error | null; addresses?: unknown }>((resolve) => {
			validatingLookup(
				'public.example',
				{ all: true } as any,
				((err: Error | null, addresses: unknown) => resolve({ err, addresses })) as any
			);
		});

		expect(result.err).toBeNull();

		expect(result.addresses).toEqual([
			{ address: '203.0.113.1', family: 4 },
			{ address: '203.0.113.2', family: 4 },
		]);
	});
});

describe('preValidateIpLiteral — synchronous pre-connect validation for IP literals', () => {
	test('returns null when host is a hostname (defers to lookup-based validation)', () => {
		const result = preValidateIpLiteral({ host: 'public.example' });
		expect(result).toBeNull();
	});

	test('returns null when IP-literal host is allowed', () => {
		const result = preValidateIpLiteral({ host: '203.0.113.1' });
		expect(result).toBeNull();
	});

	test('returns an Error when IP-literal host is on the deny-list', () => {
		const result = preValidateIpLiteral({ host: '169.254.169.254' });
		expect(result).toBeInstanceOf(Error);
		expect(result?.message).toContain('denied IP address');
	});

	test('uses options.hostname when options.host is absent', () => {
		const result = preValidateIpLiteral({ hostname: '169.254.169.254' });
		expect(result).toBeInstanceOf(Error);
	});

	test('returns null when no host or hostname is provided', () => {
		const result = preValidateIpLiteral({});
		expect(result).toBeNull();
	});
});

describe('ValidatingHttpAgent — pre-connect rejection of denied IP literals', () => {
	test('does NOT call super.createConnection when IP-literal host is denied', async () => {
		const agent = new ValidatingHttpAgent();

		const parentSpy = vi
			.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(agent)), 'createConnection')
			.mockImplementation(() => undefined);

		const callbackErr = await new Promise<Error | null>((resolve) => {
			(agent as any).createConnection({ host: '169.254.169.254', port: 80 }, (err: Error | null) => {
				resolve(err);
			});
		});

		expect(parentSpy).not.toHaveBeenCalled();
		expect(callbackErr).toBeInstanceOf(Error);
		expect(callbackErr?.message).toContain('denied IP address');
	});

	test('calls super.createConnection when IP-literal host is allowed', async () => {
		const agent = new ValidatingHttpAgent();

		const parentSpy = vi
			.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(agent)), 'createConnection')
			.mockImplementation(() => undefined);

		const callback = vi.fn();
		(agent as any).createConnection({ host: '203.0.113.1', port: 80 }, callback);

		expect(parentSpy).toHaveBeenCalledOnce();
	});

	test('calls super.createConnection for hostnames (validation deferred to lookup)', () => {
		const agent = new ValidatingHttpAgent();

		const parentSpy = vi
			.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(agent)), 'createConnection')
			.mockImplementation(() => undefined);

		const callback = vi.fn();
		(agent as any).createConnection({ host: 'public.example', port: 443 }, callback);

		expect(parentSpy).toHaveBeenCalledOnce();
		const passedOptions = parentSpy.mock.calls[0]?.[0] as { host?: string; hostname?: string };
		expect(passedOptions.host).toBe('public.example');
	});
});

describe('ValidatingHttpsAgent — construction wiring and pre-connect rejection', () => {
	test('wires validatingLookup as default agent option', () => {
		const agent = new ValidatingHttpsAgent();
		expect(((agent as any).options as { lookup?: unknown }).lookup).toBe(validatingLookup);
	});

	test('does NOT call super.createConnection when IP-literal host is denied', async () => {
		const agent = new ValidatingHttpsAgent();

		const parentSpy = vi
			.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(agent)), 'createConnection')
			.mockImplementation(() => undefined);

		const callbackErr = await new Promise<Error | null>((resolve) => {
			(agent as any).createConnection({ host: '169.254.169.254', port: 443 }, (err: Error | null) => {
				resolve(err);
			});
		});

		expect(parentSpy).not.toHaveBeenCalled();
		expect(callbackErr).toBeInstanceOf(Error);
	});

	test('preserves the original hostname in options.host when delegating for hostnames', () => {
		const agent = new ValidatingHttpsAgent();

		const parentSpy = vi
			.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(agent)), 'createConnection')
			.mockImplementation(() => undefined);

		(agent as any).createConnection({ host: 's3.amazonaws.com', port: 443, servername: 's3.amazonaws.com' }, vi.fn());

		expect(parentSpy).toHaveBeenCalledOnce();
		const passedOptions = parentSpy.mock.calls[0]?.[0] as { host?: string; servername?: string };
		expect(passedOptions.host).toBe('s3.amazonaws.com');
		expect(passedOptions.servername).toBe('s3.amazonaws.com');
	});
});
