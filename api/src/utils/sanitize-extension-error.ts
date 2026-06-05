export type SanitizedExtensionError = {
	code: string;
	detail: string;
};

const MIN_ENV_REDACT_LENGTH = 8;
const MAX_DETAIL_LENGTH = 300;

const WINDOWS_PATH = /(^|[\s'"`(=])([A-Za-z]:\\[^\s'"`)]+)/g;
const POSIX_PATH = /(^|[\s'"`(=])((?:\.{0,2}\/)[^\s'"`)]+)/g;
const SECRET_LIKE = /[A-Za-z0-9+/_-]{24,}={0,2}/g;

function deriveCode(error: unknown, fallback: string): string {
	const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
	if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return 'ENTRYPOINT_NOT_FOUND';
	return fallback;
}

function redactEnvValues(input: string): string {
	let output = input;

	for (const value of Object.values(process.env)) {
		if (typeof value === 'string' && value.length >= MIN_ENV_REDACT_LENGTH && output.includes(value)) {
			output = output.split(value).join('<redacted>');
		}
	}

	return output;
}

export function sanitizeExtensionError(error: unknown, fallbackCode = 'UNKNOWN'): SanitizedExtensionError {
	const message = error instanceof Error ? error.message : String(error);

	let detail = message.split('\n')[0] ?? '';
	detail = redactEnvValues(detail);
	detail = detail.replace(WINDOWS_PATH, '$1<path>');
	detail = detail.replace(POSIX_PATH, '$1<path>');
	detail = detail.replace(SECRET_LIKE, '<redacted>');
	detail = detail.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);

	return { code: deriveCode(error, fallbackCode), detail };
}
