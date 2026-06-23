/**
 * Reads a config variable as a raw secret. Returns the value only when it is a
 * non-empty string, never the type-coerced view from getEnv(), so a numeric or
 * boolean-looking secret is never handed back as a number or boolean.
 */
export function readRawConfigSecret(name: string): string | null {
	const raw = process.env[name];
	return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
