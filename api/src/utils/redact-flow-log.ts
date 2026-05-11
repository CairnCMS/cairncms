import { REDACT_TEXT } from '../constants.js';

const SENSITIVE_KEYS = new Set<string>(['authorization', 'cookie', 'set-cookie', 'access_token', 'refresh_token']);

const MIN_SENSITIVE_VALUE_LENGTH = 12;

const REGEX_ESCAPE = /[\\^$.*+?()[\]{}|]/g;

function escapeRegex(input: string): string {
	return input.replace(REGEX_ESCAPE, '\\$&');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function collectInto(value: unknown, out: Set<string>, path: WeakSet<object>, inheritedSensitivity: boolean): void {
	if (typeof value === 'string') {
		if (!inheritedSensitivity) return;
		const trimmed = value.trim();
		if (trimmed.length >= MIN_SENSITIVE_VALUE_LENGTH) out.add(value);
		return;
	}

	if (value === null || typeof value !== 'object') return;

	if (value instanceof Error) {
		collectInto(
			{ name: value.name, message: value.message, stack: value.stack, cause: value.cause },
			out,
			path,
			inheritedSensitivity
		);

		return;
	}

	if (path.has(value)) return;

	if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		collectInto((value as { toJSON: () => unknown }).toJSON(), out, path, inheritedSensitivity);
		return;
	}

	path.add(value);

	try {
		if (Array.isArray(value)) {
			for (const item of value) collectInto(item, out, path, inheritedSensitivity);
			return;
		}

		if (!isPlainObject(value)) return;

		for (const [key, val] of Object.entries(value)) {
			collectInto(val, out, path, inheritedSensitivity || SENSITIVE_KEYS.has(key.toLowerCase()));
		}
	} finally {
		path.delete(value);
	}
}

export function collectSensitiveValues(source: unknown): Set<string> {
	const out = new Set<string>();
	collectInto(source, out, new WeakSet<object>(), false);
	return out;
}

function scrubString(input: string, sensitiveValues: ReadonlyArray<string>): string {
	if (sensitiveValues.length === 0) return input;

	let result = input;

	for (const sv of sensitiveValues) {
		if (result.includes(sv)) {
			result = result.replace(new RegExp(escapeRegex(sv), 'g'), REDACT_TEXT);
		}
	}

	return result;
}

function normalize(value: unknown, sensitiveValues: ReadonlyArray<string>, path: WeakSet<object>): unknown {
	if (typeof value === 'string') return scrubString(value, sensitiveValues);

	if (value === null || typeof value !== 'object') return value;

	if (value instanceof Error) {
		return normalize(
			{ name: value.name, message: value.message, stack: value.stack, cause: value.cause },
			sensitiveValues,
			path
		);
	}

	if (path.has(value)) return '[Circular]';

	if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		return normalize((value as { toJSON: () => unknown }).toJSON(), sensitiveValues, path);
	}

	path.add(value);

	try {
		if (Array.isArray(value)) {
			return value.map((item) => normalize(item, sensitiveValues, path));
		}

		const result: Record<string, unknown> = {};

		for (const [key, val] of Object.entries(value)) {
			result[key] = normalize(val, sensitiveValues, path);
		}

		return result;
	} finally {
		path.delete(value);
	}
}

function applyKeyRedaction(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(applyKeyRedaction);
	if (value === null || typeof value !== 'object') return value;

	const result: Record<string, unknown> = {};

	for (const [key, val] of Object.entries(value)) {
		if (SENSITIVE_KEYS.has(key.toLowerCase())) {
			result[key] = REDACT_TEXT;
		} else {
			result[key] = applyKeyRedaction(val);
		}
	}

	return result;
}

export function redactFlowLog<T>(value: T, sensitiveValues?: ReadonlySet<string>): T {
	const values = sensitiveValues ? Array.from(sensitiveValues).filter((v) => v.length > 0) : [];
	const normalized = normalize(value, values, new WeakSet<object>());
	return applyKeyRedaction(normalized) as T;
}
