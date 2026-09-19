import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../../exceptions/config-read-failed.js';
import { assertConfigValueSafe } from '../parse-config-document.js';
import { safeLogFragment } from '../safe-log-fragment.js';

/** Reads never emit query filters, read filters, or read actions, so a hook cannot shape or observe them. */
export const UNFILTERED = { emitEvents: false } as const;

export function unreadable(subject: string, detail: string): ConfigReadFailedException {
	return new ConfigReadFailedException(`Config snapshot could not read ${subject}: ${detail}.`);
}

/**
 * A policy value that normalizes to null is absent. Every other stored value must be an object the
 * engine can round-trip, so anything else aborts rather than exporting as absent or as a foreign shape.
 */
export function parseStoredJSON(field: string, permId: unknown, value: unknown): Record<string, any> | null {
	const subject = `permission id=${safeLogFragment(permId)}`;

	if (value === null) return null;

	if (value === undefined) {
		throw unreadable(subject, `column "${field}" was absent from the row, so the read is incomplete`);
	}

	let parsed: unknown = value;

	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			throw unreadable(subject, `column "${field}" does not hold valid JSON`);
		}
	}

	if (parsed === null) return null;

	if (Array.isArray(parsed) || typeof parsed !== 'object') {
		throw unreadable(
			subject,
			`column "${field}" holds a ${Array.isArray(parsed) ? 'array' : typeof parsed} where an object belongs`
		);
	}

	// A stored value the engine cannot round-trip is a current-state failure, not bad caller input, so the
	// parser's 400 is remapped while keeping its diagnostic, which already names the row, path, and reason.
	try {
		assertConfigValueSafe(parsed, `${subject} ${field}`);
	} catch (err) {
		if (err instanceof ConfigInvalidException) throw new ConfigReadFailedException(err.message);
		throw err;
	}

	return parsed as Record<string, any>;
}

/** Field lists are stored as a comma-separated string on some vendors and a native array on others. */
export function parseStoredCSV(permId: unknown, value: unknown): string[] | null {
	const subject = `permission id=${safeLogFragment(permId)}`;

	if (value === null) return null;

	if (value === undefined) {
		throw unreadable(subject, 'column "fields" was absent from the row, so the read is incomplete');
	}

	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '') return null;
		return trimmed
			.split(',')
			.map((entry) => entry.trim())
			.sort();
	}

	return assertStringArray(subject, 'fields', value);
}

export function assertStringArray(subject: string, field: string, value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw unreadable(subject, `column "${field}" holds a ${typeof value} where a string list belongs`);
	}

	for (const entry of value) {
		if (typeof entry !== 'string') {
			throw unreadable(subject, `column "${field}" contains a ${typeof entry} element where a string belongs`);
		}
	}

	return [...(value as string[])].sort();
}
