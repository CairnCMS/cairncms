/**
 * Renders an untrusted value safe for a single-line log message. Control characters
 * collapse to a placeholder so a crafted fragment cannot split or forge log lines, and
 * an overlong fragment truncates.
 */
export function safeLogFragment(value: unknown, maxLength = 64): string {
	const text = typeof value === 'string' ? value : String(value);

	const sanitized = Array.from(text, (char) => {
		const code = char.charCodeAt(0);
		return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '?' : char;
	}).join('');

	return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}...` : sanitized;
}
