/** Parses the operator sandbox config in the project's conventions: sizes via `bytes`
 * ("16mb"), durations via `ms` ("10s"), counts as integers. Values arrive as env strings or
 * as numbers from a config file, so each parser takes `unknown`, handles a string or a
 * number deliberately, and returns a validated value or a structured error that names the
 * variable and its format. */

import { format as formatBytes, parse as parseBytes } from 'bytes';
import ms from 'ms';

export interface ConfigParseError {
	envVar: string;
	message: string;
}

export type ConfigParseResult = { ok: true; value: number } | { ok: false; error: ConfigParseError };

export interface BoundedSpec {
	envVar: string;
	defaultValue: number;
	floor: number;
	ceiling: number;
}

// A bare whole number is bytes; a whole number plus a known unit is that unit. No decimals,
// no sign, no unknown suffix, so the rule stays trivial to document and `bytes` (which is
// otherwise lax: "1gib" parses to 1) never sees a value it would misread.
const SIZE_PATTERN = /^\d+(\s?(b|kb|mb|gb|tb))?$/i;

function fail(envVar: string, message: string): ConfigParseResult {
	return { ok: false, error: { envVar, message: `${envVar} ${message}` } };
}

function isUnset(raw: unknown): boolean {
	return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}

function describe(raw: unknown): string {
	if (typeof raw === 'string') return `"${raw}"`;
	if (typeof raw === 'number') return String(raw);
	return `a ${typeof raw}`;
}

function bounded(spec: BoundedSpec, value: number, label: (n: number) => string): ConfigParseResult {
	if (value < spec.floor) return fail(spec.envVar, `must be at least ${label(spec.floor)}, got ${label(value)}`);
	if (value > spec.ceiling) return fail(spec.envVar, `must be at most ${label(spec.ceiling)}, got ${label(value)}`);
	return { ok: true, value };
}

/** Parses a size ("16mb", "256kb", a bare integer of bytes, or a number) against the spec bounds. */
export function parseSize(raw: unknown, spec: BoundedSpec): ConfigParseResult {
	if (isUnset(raw)) return { ok: true, value: spec.defaultValue };

	let value: number | null;

	if (typeof raw === 'number') {
		value = Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
	} else if (typeof raw === 'string' && SIZE_PATTERN.test(raw.trim())) {
		value = parseBytes(raw.trim());
	} else {
		value = null;
	}

	if (value === null || !Number.isSafeInteger(value) || value < 0) {
		return fail(spec.envVar, `must be a size like "16mb", got ${describe(raw)}`);
	}

	return bounded(spec, value, formatBytes);
}

/** Parses a duration ("10s", or a number of milliseconds) against the spec bounds. */
export function parseDuration(raw: unknown, spec: BoundedSpec): ConfigParseResult {
	if (isUnset(raw)) return { ok: true, value: spec.defaultValue };

	let value: number | undefined;

	if (typeof raw === 'number') {
		value = Number.isFinite(raw) && raw >= 0 ? raw : undefined;
	} else if (typeof raw === 'string') {
		value = ms(raw.trim());
	} else {
		value = undefined;
	}

	if (value === undefined || !Number.isFinite(value) || value < 0) {
		return fail(spec.envVar, `must be a duration like "10s", got ${describe(raw)}`);
	}

	return bounded(spec, value, (n) => ms(n));
}

/** Parses a count (a whole number, as a string or a number) against the spec bounds. */
export function parseCount(raw: unknown, spec: BoundedSpec): ConfigParseResult {
	if (isUnset(raw)) return { ok: true, value: spec.defaultValue };

	let value: number | null;

	if (typeof raw === 'number') {
		value = Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
	} else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
		value = Number(raw.trim());
	} else {
		value = null;
	}

	if (value === null || !Number.isSafeInteger(value) || value < 0) {
		return fail(spec.envVar, `must be a whole number, got ${describe(raw)}`);
	}

	return bounded(spec, value, String);
}
