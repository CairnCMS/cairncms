import { afterEach, describe, expect, test } from 'vitest';
import type { RequestError } from '@/api';
import { i18n, translateAPIError } from './index';

function requestErrorWithCode(code: string): RequestError {
	return { message: 'Request failed', response: { data: { errors: [{ extensions: { code } }] } } } as RequestError;
}

const networkError = { message: 'Network Error' } as RequestError;

describe('translateAPIError', () => {
	afterEach(() => {
		i18n.global.mergeLocaleMessage('en-US', { 'errors.undefined': undefined });
	});

	test('returns the translation for a string error code', () => {
		expect(translateAPIError('FORBIDDEN')).toBe(i18n.global.t('errors.FORBIDDEN'));
	});

	test('returns the translation for the code in a request error', () => {
		expect(translateAPIError(requestErrorWithCode('INVALID_CREDENTIALS'))).toBe(
			i18n.global.t('errors.INVALID_CREDENTIALS')
		);
	});

	test('returns the default message for a request error without a code', () => {
		expect(translateAPIError(networkError)).toBe(i18n.global.t('unexpected_error'));
	});

	test('returns the default message for an unknown code', () => {
		expect(translateAPIError('NOT_A_KNOWN_CODE')).toBe(i18n.global.t('unexpected_error'));
	});

	test('returns the default message for a request error without a code when a custom translation uses errors.undefined', () => {
		i18n.global.mergeLocaleMessage('en-US', { 'errors.undefined': 'Custom text for a missing code' });

		expect(translateAPIError(networkError)).toBe(i18n.global.t('unexpected_error'));
	});
});
