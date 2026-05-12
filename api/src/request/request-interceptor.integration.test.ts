import type { InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { envMock } = vi.hoisted(() => ({
	envMock: { IMPORT_IP_DENY_LIST: ['169.254.169.254'] } as Record<string, unknown>,
}));

vi.mock('../env', () => ({
	default: envMock,
	getEnv: () => envMock,
}));

vi.mock('../logger');
vi.mock('node:os');

vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(),
}));

const { requestInterceptor } = await import('./request-interceptor.js');

const { lookup } = await import('node:dns/promises');

const ATTACKER_URL = 'https://attacker.example/';

function buildConfig(): InternalAxiosRequestConfig {
	return {
		url: ATTACKER_URL,
		method: 'get',
		headers: {} as InternalAxiosRequestConfig['headers'],
	};
}

beforeEach(() => {
	envMock['IMPORT_IP_DENY_LIST'] = ['169.254.169.254'];
});

afterEach(() => {
	vi.resetAllMocks();
});

test('Denies a hostname whose DNS resolves to an IPv4-mapped IPv6 form of a deny-listed address', async () => {
	vi.mocked(lookup).mockResolvedValue({ address: '::ffff:169.254.169.254', family: 6 });

	await expect(requestInterceptor(buildConfig())).rejects.toThrow(
		`Requested URL "${ATTACKER_URL}" resolves to a denied IP address`
	);
});

test('Denies a hostname whose DNS resolves to the native IPv4 form of a deny-listed address (regression)', async () => {
	vi.mocked(lookup).mockResolvedValue({ address: '169.254.169.254', family: 4 });

	await expect(requestInterceptor(buildConfig())).rejects.toThrow(
		`Requested URL "${ATTACKER_URL}" resolves to a denied IP address`
	);
});

test('Allows a hostname whose DNS resolves to an address not in the deny list (negative control)', async () => {
	vi.mocked(lookup).mockResolvedValue({ address: '198.51.100.1', family: 4 });

	const config = buildConfig();
	const result = await requestInterceptor(config);
	expect(result).toBe(config);
});
