import { randIp, randUrl } from '@ngneat/falso';
import os from 'node:os';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getEnv } from '../env.js';
import { validateIP } from './validate-ip.js';

vi.mock('../env');
vi.mock('node:os');

let sample: {
	ip: string;
	url: string;
};

beforeEach(() => {
	sample = {
		ip: randIp(),
		url: randUrl(),
	};
});

afterEach(() => {
	vi.resetAllMocks();
});

test(`Does nothing if IP is valid`, async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: [] });
	await validateIP(sample.ip, sample.url);
});

test(`Throws error if passed IP is denylisted`, async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: [sample.ip] });

	try {
		await validateIP(sample.ip, sample.url);
	} catch (err: any) {
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe(`Requested URL "${sample.url}" resolves to a denied IP address`);
	}
});

test(`Checks against IPs of local networkInterfaces if IP deny list contains 0.0.0.0`, async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });
	vi.mocked(os.networkInterfaces).mockReturnValue({});
	await validateIP(sample.ip, sample.url);
	expect(os.networkInterfaces).toHaveBeenCalledOnce();
});

test(`Throws error if IP address matches resolved localhost IP`, async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });

	vi.mocked(os.networkInterfaces).mockReturnValue({
		fa0: undefined,
		lo0: [
			{
				address: '127.0.0.1',
				netmask: '255.0.0.0',
				family: 'IPv4',
				mac: '00:00:00:00:00:00',
				internal: true,
				cidr: '127.0.0.1/8',
			},
		],
		en0: [
			{
				address: sample.ip,
				netmask: '255.0.0.0',
				family: 'IPv4',
				mac: '00:00:00:00:00:00',
				internal: true,
				cidr: '127.0.0.1/8',
			},
		],
	});

	try {
		await validateIP(sample.ip, sample.url);
	} catch (err: any) {
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe(`Requested URL "${sample.url}" resolves to a denied IP address`);
	}
});

const DENY_URL = 'http://attacker.example/';

async function expectDenied(ip: string, url: string) {
	let thrown: unknown = null;

	try {
		await validateIP(ip, url);
	} catch (err) {
		thrown = err;
	}

	expect(thrown).toBeInstanceOf(Error);
	expect((thrown as Error).message).toBe(`Requested URL "${url}" resolves to a denied IP address`);
}

async function expectAllowed(ip: string, url: string) {
	await expect(validateIP(ip, url)).resolves.toBeUndefined();
}

test.each([
	['dotted-decimal mixed', '::ffff:169.254.169.254'],
	['compressed hex', '::ffff:a9fe:a9fe'],
	['fully expanded', '0:0:0:0:0:ffff:a9fe:a9fe'],
])('Denies IPv4-mapped IPv6 (%s) when the IPv4 equivalent is in the deny list', async (_label, mapped) => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['169.254.169.254'] });
	await expectDenied(mapped, DENY_URL);
});

test.each([
	['dotted-decimal mixed', '::ffff:127.0.0.1'],
	['compressed hex', '::ffff:7f00:1'],
	['fully expanded', '0:0:0:0:0:ffff:7f00:1'],
])('Denies IPv4-mapped IPv6 loopback (%s) via the 0.0.0.0 local-interface branch', async (_label, mapped) => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });

	vi.mocked(os.networkInterfaces).mockReturnValue({
		lo0: [
			{
				address: '127.0.0.1',
				netmask: '255.0.0.0',
				family: 'IPv4',
				mac: '00:00:00:00:00:00',
				internal: true,
				cidr: '127.0.0.1/8',
			},
		],
	});

	await expectDenied(mapped, DENY_URL);
});

test('Native IPv4 entry in deny list is still denied (regression)', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['169.254.169.254'] });
	await expectDenied('169.254.169.254', DENY_URL);
});

test('Native IPv4 loopback is still denied via local-interface branch (regression)', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });

	vi.mocked(os.networkInterfaces).mockReturnValue({
		lo0: [
			{
				address: '127.0.0.1',
				netmask: '255.0.0.0',
				family: 'IPv4',
				mac: '00:00:00:00:00:00',
				internal: true,
				cidr: '127.0.0.1/8',
			},
		],
	});

	await expectDenied('127.0.0.1', DENY_URL);
});

test('Non-mapped IPv6 address that is not in the deny list passes through', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['169.254.169.254'] });
	await expectAllowed('2001:db8::1', DENY_URL);
});

test('Plain IPv4 address that is not in the deny list passes through', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['169.254.169.254'] });
	await expectAllowed('198.51.100.1', DENY_URL);
});
