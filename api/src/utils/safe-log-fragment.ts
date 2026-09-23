export function replaceControlCharacters(value: unknown): string {
	const text = typeof value === 'string' ? value : String(value);

	return Array.from(text, (char) => {
		const code = char.charCodeAt(0);
		return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '?' : char;
	}).join('');
}

/** Replaces control characters and truncates a value so it cannot forge additional log lines. */
export function safeLogFragment(value: unknown, maxLength = 64): string {
	const sanitized = replaceControlCharacters(value);

	return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}...` : sanitized;
}
