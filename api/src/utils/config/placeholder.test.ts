import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { ConfigPlaceholderUnresolvedException } from '../../exceptions/config-placeholder-unresolved.js';
import { interpolateEnvVar, isPlaceholder } from './placeholder.js';

describe('isPlaceholder', () => {
	it('recognizes only the whole-string placeholder form', () => {
		expect(isPlaceholder('{{CAIRNCMS_CONFIG_X}}')).toBe(true);
		expect(isPlaceholder('prefix {{CAIRNCMS_CONFIG_X}}')).toBe(false);
		expect(isPlaceholder(42)).toBe(false);
	});
});

describe('interpolateEnvVar', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('returns a non-placeholder value unchanged', () => {
		expect(interpolateEnvVar('plain', 'name', { label: 'role', value: 'editor' })).toBe('plain');
	});

	it('substitutes an in-namespace variable', () => {
		vi.stubEnv('CAIRNCMS_CONFIG_NAME', 'Resolved');
		expect(interpolateEnvVar('{{CAIRNCMS_CONFIG_NAME}}', 'name', { label: 'role', value: 'editor' })).toBe('Resolved');
	});

	it('sanitizes a hostile subject label and value in the out-of-namespace diagnostic', () => {
		let error: unknown;

		try {
			interpolateEnvVar('{{OTHER_VAR}}', 'name', {
				label: `ro${String.fromCharCode(2)}le`,
				value: `ev${String.fromCharCode(1)}il`,
			});
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(ConfigInvalidException);
		expect((error as Error).message).toContain('ro?le');
		expect((error as Error).message).toContain('ev?il');
		expect((error as Error).message).not.toContain(String.fromCharCode(1));
		expect((error as Error).message).not.toContain(String.fromCharCode(2));
	});

	it('sanitizes a hostile subject label and value in the unresolved-variable diagnostic', () => {
		let error: unknown;

		try {
			interpolateEnvVar('{{CAIRNCMS_CONFIG_MISSING}}', 'name', {
				label: `ro${String.fromCharCode(2)}le`,
				value: `ev${String.fromCharCode(1)}il`,
			});
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(ConfigPlaceholderUnresolvedException);
		expect((error as Error).message).toContain('ro?le');
		expect((error as Error).message).toContain('ev?il');
		expect((error as Error).message).not.toContain(String.fromCharCode(1));
		expect((error as Error).message).not.toContain(String.fromCharCode(2));
	});
});
