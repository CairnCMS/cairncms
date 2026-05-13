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
])('Denies IPv4-mapped IPv6 loopback (%s) when 0.0.0.0 is in the deny-list', async (_label, mapped) => {
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

test('Native IPv4 loopback is still denied when 0.0.0.0 is in the deny-list (regression)', async () => {
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

function mockOnlyLoopbackInterface() {
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
}

test('GHSA-68g8-c275-xf2m: 127.0.0.2 is denied when 0.0.0.0 is in the deny-list', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });
	mockOnlyLoopbackInterface();
	await expectDenied('127.0.0.2', DENY_URL);
});

test('GHSA-68g8-c275-xf2m: 127.127.127.127 is denied when 0.0.0.0 is in the deny-list', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });
	mockOnlyLoopbackInterface();
	await expectDenied('127.127.127.127', DENY_URL);
});

test('GHSA-68g8-c275-xf2m: 127.255.255.254 is denied when 0.0.0.0 is in the deny-list', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });
	mockOnlyLoopbackInterface();
	await expectDenied('127.255.255.254', DENY_URL);
});

test('GHSA-68g8-c275-xf2m: IPv6 loopback ::1 is denied when 0.0.0.0 is in the deny-list', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });
	mockOnlyLoopbackInterface();
	await expectDenied('::1', DENY_URL);
});

test('GHSA-68g8-c275-xf2m: IPv4-mapped IPv6 loopback-range form is denied when 0.0.0.0 is in the deny-list', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });
	mockOnlyLoopbackInterface();
	await expectDenied('::ffff:127.0.0.2', DENY_URL);
});

test('regression: 127.0.0.1 still denied when 0.0.0.0 is in the deny-list', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });
	mockOnlyLoopbackInterface();
	await expectDenied('127.0.0.1', DENY_URL);
});

test('regression: public IP still passes when 0.0.0.0 is in the deny-list', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });
	mockOnlyLoopbackInterface();
	await expectAllowed('8.8.8.8', DENY_URL);
});

test('regression: empty deny-list lets any IP through', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: [] });
	await expectAllowed('127.0.0.2', DENY_URL);
});

test('regression: literal 127.0.0.1 in deny-list (without 0.0.0.0) does not block 127.0.0.2', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['127.0.0.1'] });
	mockOnlyLoopbackInterface();
	await expectAllowed('127.0.0.2', DENY_URL);
});

test('regression: literal 127.0.0.1 in deny-list (without 0.0.0.0) still blocks exact 127.0.0.1', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['127.0.0.1'] });
	mockOnlyLoopbackInterface();
	await expectDenied('127.0.0.1', DENY_URL);
});

test('regression: 0.0.0.0 in deny-list still catches a bound non-loopback interface address', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });

	vi.mocked(os.networkInterfaces).mockReturnValue({
		eth0: [
			{
				address: '192.168.1.5',
				netmask: '255.255.255.0',
				family: 'IPv4',
				mac: '00:00:00:00:00:00',
				internal: false,
				cidr: '192.168.1.5/24',
			},
		],
	});

	await expectDenied('192.168.1.5', DENY_URL);
});

test('composition with GHSA-wv3h-5fx7-966h: IPv4-mapped IPv6 of 127.0.0.1 is denied when 0.0.0.0 is in the deny-list', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['0.0.0.0'] });
	mockOnlyLoopbackInterface();
	await expectDenied('::ffff:127.0.0.1', DENY_URL);
});

test('composition with GHSA-wv3h-5fx7-966h: IPv4-mapped IPv6 of 169.254.169.254 is denied via canonical match', async () => {
	vi.mocked(getEnv).mockReturnValue({ IMPORT_IP_DENY_LIST: ['169.254.169.254'] });
	await expectDenied('::ffff:169.254.169.254', DENY_URL);
});
