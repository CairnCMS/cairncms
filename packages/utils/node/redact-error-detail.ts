const MIN_ENV_REDACT_LENGTH = 8;
const MAX_DETAIL_LENGTH = 300;

const WINDOWS_PATH = /(^|[\s'"`(=])([A-Za-z]:\\[^\s'"`)]+)/g;
const POSIX_PATH = /(^|[\s'"`(=])((?:\.{0,2}\/)[^\s'"`)]+)/g;
const SECRET_LIKE = /[A-Za-z0-9+/_-]{24,}={0,2}/g;

export function redactErrorDetail(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);

	let detail = message.split('\n')[0] ?? '';

	for (const value of Object.values(process.env)) {
		if (typeof value === 'string' && value.length >= MIN_ENV_REDACT_LENGTH && detail.includes(value)) {
			detail = detail.split(value).join('<redacted>');
		}
	}

	detail = detail.replace(WINDOWS_PATH, '$1<path>');
	detail = detail.replace(POSIX_PATH, '$1<path>');
	detail = detail.replace(SECRET_LIKE, '<redacted>');

	return detail.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);
}
