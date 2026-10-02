import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { ConfigPlaceholderUnresolvedException } from '../../exceptions/config-placeholder-unresolved.js';
import type { ConfigFieldDescriptor } from './descriptor.js';
import { interpolateEnvVar, interpolatePlaceholderFields, isPlaceholder, placeholderVarName } from './placeholder.js';

function field(name: string, acceptsPlaceholder: boolean): ConfigFieldDescriptor {
	return { name, acceptsPlaceholder } as unknown as ConfigFieldDescriptor;
}

describe('isPlaceholder', () => {
	it('recognizes only the whole-string placeholder form', () => {
		expect(isPlaceholder('{{CAIRNCMS_CONFIG_X}}')).toBe(true);
		expect(isPlaceholder('prefix {{CAIRNCMS_CONFIG_X}}')).toBe(false);
		expect(isPlaceholder(42)).toBe(false);
	});
});

describe('placeholderVarName', () => {
	it('returns the variable name of a whole-string placeholder', () => {
		expect(placeholderVarName('{{CAIRNCMS_CONFIG_X}}')).toBe('CAIRNCMS_CONFIG_X');
	});

	it('returns undefined for a non-placeholder or a non-string', () => {
		expect(placeholderVarName('prefix {{CAIRNCMS_CONFIG_X}}')).toBeUndefined();
		expect(placeholderVarName(42)).toBeUndefined();
	});
});

describe('interpolatePlaceholderFields', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('substitutes only acceptsPlaceholder string fields and copies the record', () => {
		vi.stubEnv('CAIRNCMS_CONFIG_A', 'resolved');

		const record = { a: '{{CAIRNCMS_CONFIG_A}}', b: '{{CAIRNCMS_CONFIG_B}}', c: 7 };
		const fields = [field('a', true), field('b', false), field('c', true)];

		const out = interpolatePlaceholderFields(fields, record, { label: 'x', value: 'y' });

		expect(out).not.toBe(record);
		expect(out['a']).toBe('resolved');
		expect(out['b']).toBe('{{CAIRNCMS_CONFIG_B}}');
		expect(out['c']).toBe(7);
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
