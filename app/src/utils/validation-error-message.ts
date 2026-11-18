import { i18n } from '@/lang';
import type { ValidationError } from '@cairncms/types';

/** Rule types whose existing `validationError` messages contain no placeholders in any locale. */
export const VALUE_FREE_TYPES: readonly string[] = ['null', 'nnull', 'empty', 'nempty', 'required', 'regex'];

/** Returns the message for a validation error. It passes no interpolation values, so no translation can show a compared value or a blank in its place. */
export function validationErrorMessage(error: Pick<ValidationError, 'code' | 'type'>): string {
	const { t, te } = i18n.global;

	if (error.code === 'RECORD_NOT_UNIQUE') return t('validationError.unique');

	if (error.type && VALUE_FREE_TYPES.includes(error.type)) return t(`validationError.${error.type}`);

	if (error.type && te(`validation_failure.${error.type}`)) return t(`validation_failure.${error.type}`);

	return t('validationError.regex');
}
