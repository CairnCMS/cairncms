import { REDACT_TEXT } from '../constants.js';

/**
 * Percent-encoding hex digits are case-insensitive, so the escapes are
 * lowercased as their own variant. Only the escapes change case, the literal
 * characters of the secret stay as they are.
 */
function lowercasePercentEscapes(encoded: string): string {
	return encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

/**
 * Expands each secret into the encoded forms a downstream system may echo it
 * in, so an occurrence survives scrubbing in none of them. Variant list
 * adapted from Zapier's secret-scrubber: as-is, percent-encoded and
 * percent-encoded with plus for space in both hex cases, JSON-escaped, and
 * base64.
 */
function expandSecretVariants(secrets: readonly string[]): string[] {
	const variants = new Set<string>();

	for (const secret of secrets) {
		if (secret.length === 0) continue;

		const encoded = encodeURIComponent(secret);
		const lowerEncoded = lowercasePercentEscapes(encoded);

		variants.add(secret);
		variants.add(encoded);
		variants.add(lowerEncoded);
		variants.add(encoded.replaceAll('%20', '+'));
		variants.add(lowerEncoded.replaceAll('%20', '+'));
		variants.add(JSON.stringify(secret).slice(1, -1));
		variants.add(Buffer.from(secret).toString('base64'));
	}

	return [...variants];
}

/**
 * The replacement for a value that cannot be scrubbed in place. The marker is
 * only safe when it contains no active secret in any encoded form, otherwise
 * the collapse falls back to the empty string.
 */
export function redactionFallback(secrets: readonly string[]): string {
	return expandSecretVariants(secrets).some((secret) => REDACT_TEXT.includes(secret)) ? '' : REDACT_TEXT;
}

/**
 * Replaces every occurrence of every secret, in every encoded variant, with
 * the redaction marker and guarantees none survives in the returned string.
 * Longer secrets scrub first, so a secret contained in another is not broken
 * apart before the longer one matches. Split-and-join replaces in a single
 * pass with no rescan of the replacement, and a post-check collapses the
 * whole string whenever a replacement could still expose a secret, such as a
 * secret that is a substring of the marker or one formed at a replacement
 * boundary.
 */
export function scrubString(value: string, secrets: readonly string[]): string {
	const active = expandSecretVariants(secrets);
	if (active.length === 0) return value;

	let result = value;

	for (const secret of active.sort((a, b) => b.length - a.length)) {
		if (result.includes(secret)) result = result.split(secret).join(REDACT_TEXT);
	}

	if (active.some((secret) => result.includes(secret))) return redactionFallback(secrets);

	return result;
}
