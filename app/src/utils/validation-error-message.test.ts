import { i18n } from '@/lang';
import type { ValidationError } from '@cairncms/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validationErrorMessage } from './validation-error-message';

vi.mock('@/lang', async () => {
	const { createI18n } = await import('vue-i18n');
	const { default: enUS } = await import('@/lang/translations/en-US.yaml');

	return {
		i18n: createI18n({
			legacy: false,
			locale: 'en-US',
			fallbackLocale: 'en-US',
			silentTranslationWarn: true,
			messages: {
				'en-US': enUS,
				'xx-OLD': { validationError: { eq: 'Old template {valid}', required: 'Old required' } },
				'xx-NEW': { validation_failure: { eq: 'Translated equality' } },
			},
		}),
	};
});

const failure = (type: string): Pick<ValidationError, 'code' | 'type'> => ({
	code: 'FAILED_VALIDATION',
	type: type as ValidationError['type'],
});

afterEach(() => {
	i18n.global.locale.value = 'en-US';
});

describe('validationErrorMessage', () => {
	it.each([
		['eq', 'Value has to be the required value'],
		['neq', `Value can't be the excluded value`],
		['in', 'Value has to be one of the allowed values'],
		['nin', `Value can't be one of the excluded values`],
		['contains', 'Value has to contain the required text'],
		['ncontains', `Value can't contain the excluded text`],
		['gt', 'Value has to be greater than the minimum'],
		['gte', 'Value has to be greater than or equal to the minimum'],
		['lt', 'Value has to be less than the maximum'],
		['lte', 'Value has to be less than or equal to the maximum'],
		['null', 'Value has to be null'],
		['nnull', `Value can't be null`],
		['empty', 'Value has to be empty'],
		['nempty', `Value can't be empty`],
		['required', 'Value is required'],
		['regex', `Value doesn't have the correct format`],
	])('gives the %s message', (type, message) => {
		expect(validationErrorMessage(failure(type))).toBe(message);
	});

	it('gives the unique message for a duplicate value', () => {
		expect(validationErrorMessage({ code: 'RECORD_NOT_UNIQUE' })).toBe('Value has to be unique');
	});

	it('falls back to the format message when the type is absent or unknown', () => {
		expect(validationErrorMessage({ code: 'FAILED_VALIDATION' })).toBe(`Value doesn't have the correct format`);
		expect(validationErrorMessage(failure('unknown_rule'))).toBe(`Value doesn't have the correct format`);
	});

	it('never renders a value the error still carries', () => {
		const error = { code: 'FAILED_VALIDATION', type: 'eq', valid: 'SECRET_OPERAND' } as unknown as ValidationError;

		expect(validationErrorMessage(error)).toBe('Value has to be the required value');
	});

	it('uses the English message, not an old translated template, when a locale lacks the new key', () => {
		i18n.global.locale.value = 'xx-OLD';

		expect(validationErrorMessage(failure('eq'))).toBe('Value has to be the required value');
		expect(validationErrorMessage(failure('required'))).toBe('Old required');
	});

	it('uses a locale translation of the new key when one exists', () => {
		i18n.global.locale.value = 'xx-NEW';

		expect(validationErrorMessage(failure('eq'))).toBe('Translated equality');
	});
});
