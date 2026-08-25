import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { ConfigPlaceholderUnresolvedException } from '../../exceptions/config-placeholder-unresolved.js';
import { safeLogFragment } from '../safe-log-fragment.js';

export const ENV_VAR_PATTERN = /^\{\{([A-Z_][A-Z0-9_]*)\}\}$/;

export const PLACEHOLDER_NAMESPACE = 'CAIRNCMS_CONFIG_';

/** Whether a value is the whole-string placeholder form the reader would substitute. */
export function isPlaceholder(value: unknown): boolean {
	return typeof value === 'string' && ENV_VAR_PATTERN.test(value);
}

/**
 * Substitutes a whole-string `{{CAIRNCMS_CONFIG_*}}` placeholder from the environment. `subject` names
 * the document the value belongs to; both its parts are sanitized here, so no caller can leak a raw
 * identity into a diagnostic.
 */
export function interpolateEnvVar(value: string, field: string, subject: { label: string; value: unknown }): string {
	const match = value.match(ENV_VAR_PATTERN);
	if (!match) return value;

	const varName = match[1]!;
	const where = `${safeLogFragment(subject.label)} "${safeLogFragment(subject.value)}" field "${field}"`;

	if (!varName.startsWith(PLACEHOLDER_NAMESPACE)) {
		throw new ConfigInvalidException(
			`${where} references {{${safeLogFragment(varName)}}}, which is outside the ${PLACEHOLDER_NAMESPACE} namespace. ` +
				`Only variables in that namespace are substituted.`
		);
	}

	const resolved = process.env[varName];

	if (resolved === undefined) {
		throw new ConfigPlaceholderUnresolvedException(
			`${where} references {{${safeLogFragment(varName)}}}, which has no value in this environment.`
		);
	}

	return resolved;
}
