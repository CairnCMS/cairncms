import { afterEach, describe, expect, it } from 'vitest';
import { readRawConfigSecret } from './read-raw-config-secret.js';

describe('readRawConfigSecret', () => {
	const original = { ...process.env };

	afterEach(() => {
		process.env = { ...original };
	});

	it('returns a numeric-looking value as a string, never coerced', () => {
		process.env['CAIRN_TEST_SECRET'] = '12345';

		const result = readRawConfigSecret('CAIRN_TEST_SECRET');

		expect(result).toBe('12345');
		expect(typeof result).toBe('string');
	});

	it('returns null for a missing variable', () => {
		delete process.env['CAIRN_TEST_MISSING'];

		expect(readRawConfigSecret('CAIRN_TEST_MISSING')).toBeNull();
	});

	it('returns null for an empty string', () => {
		process.env['CAIRN_TEST_EMPTY'] = '';

		expect(readRawConfigSecret('CAIRN_TEST_EMPTY')).toBeNull();
	});
});
