import { redactErrorDetail } from '@cairncms/utils/node';

export type SanitizedExtensionError = {
	code: string;
	detail: string;
};

function deriveCode(error: unknown, fallback: string): string {
	const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
	if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return 'ENTRYPOINT_NOT_FOUND';
	return fallback;
}

export function sanitizeExtensionError(error: unknown, fallbackCode = 'UNKNOWN'): SanitizedExtensionError {
	return { code: deriveCode(error, fallbackCode), detail: redactErrorDetail(error) };
}
