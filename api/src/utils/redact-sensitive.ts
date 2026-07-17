import { REDACT_TEXT } from '../constants.js';
import { redactionFallback, scrubString } from './scrub-string.js';

const SENSITIVE_KEYS = new Set<string>([
	'authorization',
	'cookie',
	'set-cookie',
	'access_token',
	'refresh_token',
	'password',
	'token',
	'tfa_secret',
	'external_identifier',
	'auth_data',
	'credentials',
	'ai_openai_api_key',
	'ai_anthropic_api_key',
	'ai_google_api_key',
	'ai_openai_compatible_api_key',
]);

const MIN_SENSITIVE_VALUE_LENGTH = 12;

type CollectOptions = { minLength: number; includeNumbers: boolean };

const FLOORED_COLLECT_OPTIONS: CollectOptions = { minLength: MIN_SENSITIVE_VALUE_LENGTH, includeNumbers: false };
const EXHAUSTIVE_COLLECT_OPTIONS: CollectOptions = { minLength: 1, includeNumbers: true };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isSensitiveKey(key: string, extraKeys: ReadonlySet<string> | undefined): boolean {
	const lowered = key.toLowerCase();
	return SENSITIVE_KEYS.has(lowered) || (extraKeys !== undefined && extraKeys.has(lowered));
}

function collectInto(
	value: unknown,
	out: Set<string>,
	path: WeakSet<object>,
	inheritedSensitivity: boolean,
	extraKeys: ReadonlySet<string> | undefined,
	options: CollectOptions
): void {
	if (typeof value === 'string') {
		if (!inheritedSensitivity) return;
		const trimmed = value.trim();
		if (trimmed.length >= options.minLength) out.add(value);
		return;
	}

	if (options.includeNumbers && inheritedSensitivity && typeof value === 'number' && Number.isFinite(value)) {
		out.add(String(value));
		return;
	}

	if (value === null || typeof value !== 'object') return;

	if (value instanceof Error) {
		collectInto(
			{ name: value.name, message: value.message, stack: value.stack, cause: value.cause },
			out,
			path,
			inheritedSensitivity,
			extraKeys,
			options
		);

		return;
	}

	if (path.has(value)) return;

	if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		collectInto((value as { toJSON: () => unknown }).toJSON(), out, path, inheritedSensitivity, extraKeys, options);
		return;
	}

	path.add(value);

	try {
		if (Array.isArray(value)) {
			for (const item of value) collectInto(item, out, path, inheritedSensitivity, extraKeys, options);
			return;
		}

		if (!isPlainObject(value)) return;

		for (const [key, val] of Object.entries(value)) {
			collectInto(val, out, path, inheritedSensitivity || isSensitiveKey(key, extraKeys), extraKeys, options);
		}
	} finally {
		path.delete(value);
	}
}

/** Collects strings at least 12 characters long beneath sensitive keys. */
export function collectSensitiveValues(source: unknown, extraSensitiveKeys?: ReadonlySet<string>): Set<string> {
	const out = new Set<string>();
	collectInto(source, out, new WeakSet<object>(), false, extraSensitiveKeys, FLOORED_COLLECT_OPTIONS);
	return out;
}

/** Collects nonblank strings and finite numbers beneath sensitive keys, with no length floor. */
export function collectSensitiveValuesExhaustive(
	source: unknown,
	extraSensitiveKeys?: ReadonlySet<string>
): Set<string> {
	const out = new Set<string>();
	collectInto(source, out, new WeakSet<object>(), false, extraSensitiveKeys, EXHAUSTIVE_COLLECT_OPTIONS);
	return out;
}

function normalize(
	value: unknown,
	sensitiveValues: ReadonlyArray<string>,
	path: WeakSet<object>,
	extraKeys: ReadonlySet<string> | undefined
): unknown {
	if (typeof value === 'string') return scrubString(value, sensitiveValues);

	// A numeric sensitive value is matched exactly, since substring scrubbing applies only to
	// strings.
	if (typeof value === 'number' || typeof value === 'bigint') {
		return sensitiveValues.includes(String(value)) ? REDACT_TEXT : value;
	}

	if (value === null || typeof value !== 'object') return value;

	if (value instanceof Error) {
		return normalize(
			{ name: value.name, message: value.message, stack: value.stack, cause: value.cause },
			sensitiveValues,
			path,
			extraKeys
		);
	}

	if (path.has(value)) return '[Circular]';

	if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		return normalize((value as { toJSON: () => unknown }).toJSON(), sensitiveValues, path, extraKeys);
	}

	path.add(value);

	try {
		if (Array.isArray(value)) {
			return value.map((item) => normalize(item, sensitiveValues, path, extraKeys));
		}

		const result: Record<string, unknown> = {};

		for (const [key, val] of Object.entries(value)) {
			if (isSensitiveKey(key, extraKeys)) {
				// The key check runs on the original value, so the collapse decision
				// can see whether the marker would contain it.
				result[key] = typeof val === 'string' ? redactionFallback([val]) : REDACT_TEXT;
			} else {
				result[key] = normalize(val, sensitiveValues, path, extraKeys);
			}
		}

		return result;
	} finally {
		path.delete(value);
	}
}

export function redactSensitive<T>(
	value: T,
	sensitiveValues: ReadonlySet<string>,
	extraSensitiveKeys?: ReadonlySet<string>
): T {
	return normalize(value, Array.from(sensitiveValues), new WeakSet<object>(), extraSensitiveKeys) as T;
}

export function redactKeysOnly<T>(value: T, extraSensitiveKeys?: ReadonlySet<string>): T {
	return normalize(value, [], new WeakSet<object>(), extraSensitiveKeys) as T;
}
