import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getEnv, refreshEnv } from '../env.js';
import { validateIpProxyConfig } from './validate-ip-proxy-config.js';

describe('validateIpProxyConfig', () => {
	let trust: unknown;
	let header: unknown;

	beforeEach(() => {
		trust = getEnv()['IP_TRUST_PROXY'];
		header = getEnv()['IP_CUSTOM_HEADER'];
	});

	afterEach(() => {
		getEnv()['IP_TRUST_PROXY'] = trust;
		getEnv()['IP_CUSTOM_HEADER'] = header;
	});

	test('accepts the false default', () => {
		getEnv()['IP_TRUST_PROXY'] = false;
		getEnv()['IP_CUSTOM_HEADER'] = false;
		expect(() => validateIpProxyConfig()).not.toThrow();
	});

	test('accepts true, a hop count, a preset, a CIDR string, and a CIDR array', () => {
		getEnv()['IP_CUSTOM_HEADER'] = false;

		for (const value of [true, 2, 'loopback', '10.0.0.5/32', '10.0.0.5/32, 127.0.0.1', ['10.0.0.5/32', '127.0.0.1']]) {
			getEnv()['IP_TRUST_PROXY'] = value as never;
			expect(() => validateIpProxyConfig()).not.toThrow();
		}
	});

	test('rejects an invalid trust value naming the variable', () => {
		getEnv()['IP_CUSTOM_HEADER'] = false;
		getEnv()['IP_TRUST_PROXY'] = 'not-a-cidr' as never;
		expect(() => validateIpProxyConfig()).toThrow('IP_TRUST_PROXY');
	});

	test('accepts a header name for the custom header', () => {
		getEnv()['IP_TRUST_PROXY'] = false;
		getEnv()['IP_CUSTOM_HEADER'] = 'X-Real-IP' as never;
		expect(() => validateIpProxyConfig()).not.toThrow();
	});

	test('rejects a non-string, empty, whitespace, or non-token custom header naming the variable', () => {
		getEnv()['IP_TRUST_PROXY'] = false;

		for (const value of [true, 123, '', '   ', 'X Real IP']) {
			getEnv()['IP_CUSTOM_HEADER'] = value as never;
			expect(() => validateIpProxyConfig()).toThrow('IP_CUSTOM_HEADER');
		}
	});
});

describe('validateIpProxyConfig through the environment loader', () => {
	const saved: Record<string, string | undefined> = {
		IP_TRUST_PROXY: process.env['IP_TRUST_PROXY'],
		IP_CUSTOM_HEADER: process.env['IP_CUSTOM_HEADER'],
	};

	afterEach(() => {
		for (const key of ['IP_TRUST_PROXY', 'IP_CUSTOM_HEADER']) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}

		refreshEnv();
	});

	test('a comma-separated trust value parses to an array and validates', () => {
		process.env['IP_TRUST_PROXY'] = '10.0.0.5/32, 127.0.0.1';
		refreshEnv();
		expect(Array.isArray(getEnv()['IP_TRUST_PROXY'])).toBe(true);
		expect(() => validateIpProxyConfig()).not.toThrow();
	});

	test('a "true" trust value parses to a boolean and validates', () => {
		process.env['IP_TRUST_PROXY'] = 'true';
		refreshEnv();
		expect(getEnv()['IP_TRUST_PROXY']).toBe(true);
		expect(() => validateIpProxyConfig()).not.toThrow();
	});

	test('an invalid trust value from the loader fails validation', () => {
		process.env['IP_TRUST_PROXY'] = 'not-a-cidr';
		refreshEnv();
		expect(() => validateIpProxyConfig()).toThrow('IP_TRUST_PROXY');
	});

	test('a header name from the loader validates', () => {
		process.env['IP_CUSTOM_HEADER'] = 'X-Real-IP';
		refreshEnv();
		expect(() => validateIpProxyConfig()).not.toThrow();
	});

	test('a "true" custom header coerced to a boolean is rejected', () => {
		process.env['IP_CUSTOM_HEADER'] = 'true';
		refreshEnv();
		expect(getEnv()['IP_CUSTOM_HEADER']).toBe(true);
		expect(() => validateIpProxyConfig()).toThrow('IP_CUSTOM_HEADER');
	});
});
