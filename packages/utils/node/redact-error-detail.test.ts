import { afterEach, describe, expect, it } from 'vitest';
import { redactErrorDetail } from './redact-error-detail.js';

describe('redactErrorDetail', () => {
	it('keeps only the first line', () => {
		expect(redactErrorDetail(new Error('first line\nsecond line\nthird'))).toBe('first line');
	});

	it('redacts posix and windows absolute paths', () => {
		expect(redactErrorDetail(new Error('failed at /home/alison/secret/ext/index.js'))).not.toContain('/home/alison');
		expect(redactErrorDetail(new Error('failed at C:\\Users\\alison\\secret'))).not.toContain('C:\\Users');
	});

	it('redacts secret-like tokens', () => {
		const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
		expect(redactErrorDetail(new Error(`token ${token}`))).not.toContain(token);
	});

	it('redacts environment values', () => {
		process.env['CAIRN_REDACT_TEST'] = 'supersecretvalue123';
		expect(redactErrorDetail(new Error('leaked supersecretvalue123 here'))).not.toContain('supersecretvalue123');
	});

	afterEach(() => {
		delete process.env['CAIRN_REDACT_TEST'];
	});

	it('collapses whitespace and truncates', () => {
		const detail = redactErrorDetail(new Error('word '.repeat(100)));
		expect(detail.length).toBeLessThanOrEqual(300);
		expect(detail).not.toContain('  ');
	});

	it('accepts non-Error input', () => {
		expect(redactErrorDetail('plain string')).toBe('plain string');
	});
});
