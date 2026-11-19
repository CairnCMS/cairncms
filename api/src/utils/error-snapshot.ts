import { isSensitiveKey } from './redact-sensitive.js';

export const MAX_SNAPSHOT_DEPTH = 64;

const STANDARD_ERROR_FIELDS = ['message', 'stack', 'cause', 'errors'] as const;

const INCOMPLETE_SNAPSHOT = 'The error could not be inspected completely.';

type Walk = { seen: WeakSet<object>; depth: number; sensitive: boolean };

function child({ seen, depth, sensitive }: Walk, key?: string): Walk {
	return { seen, depth: depth + 1, sensitive: sensitive || (key !== undefined && isSensitiveKey(key)) };
}

// The sensitive-value collector inherits sensitivity per path, so a back-reference beneath a
// sensitive key would hide its target's fields from it.
function guard(object: object, walk: Walk): void {
	if (walk.depth > MAX_SNAPSHOT_DEPTH) throw new Error(INCOMPLETE_SNAPSHOT);
	if (walk.seen.has(object) && walk.sensitive) throw new Error(INCOMPLETE_SNAPSHOT);
}

/** Copies an array's indexed values as JSON reads them, without invoking its iterator. */
function readItems(array: readonly unknown[]): unknown[] {
	const length = array.length;
	const items = new Array<unknown>(length);

	for (let index = 0; index < length; index++) items[index] = array[index];

	return items;
}

function snapshotErrorObject(error: object, walk: Walk): Record<string, unknown> {
	guard(error, walk);
	if (walk.seen.has(error)) return { type: '[Circular]' };
	walk.seen.add(error);

	try {
		// Object.keys (not Object.entries) so the skipped originalError accessor is never invoked.
		const fields = new Map<string, unknown>();

		for (const key of Object.keys(error)) {
			if (key === 'originalError') continue;
			fields.set(key, (error as Record<string, unknown>)[key]);
		}

		for (const key of STANDARD_ERROR_FIELDS) {
			if (fields.has(key)) continue;
			const val = (error as Record<string, unknown>)[key];
			if (val !== undefined) fields.set(key, val);
		}

		const result: Record<string, unknown> = {};

		const errorConstructor = fields.has('constructor')
			? fields.get('constructor')
			: (error as { constructor?: unknown }).constructor;

		if (typeof errorConstructor === 'function') {
			result['type'] = errorConstructor.name;
		} else if (fields.has('name')) {
			result['type'] = fields.get('name');
		} else {
			result['type'] = (error as { name?: string }).name;
		}

		for (const [key, val] of fields) {
			if (key === 'errors' && Array.isArray(val)) {
				result['aggregateErrors'] = readItems(val).map((item) => toPlain(item, child(walk, 'aggregateErrors')));
				continue;
			}

			if (key in result) continue;

			const plain = toPlain(val, child(walk, key));
			if (plain !== undefined) result[key] = plain;
		}

		return result;
	} finally {
		walk.seen.delete(error);
	}
}

function toPlain(value: unknown, walk: Walk, fromToJSON = false): unknown {
	if (value === null) return null;

	switch (typeof value) {
		case 'string':
		case 'boolean':
			return value;
		case 'number':
			return Number.isFinite(value) ? value : null;
		case 'bigint':
			return value.toString();
		case 'undefined':
		case 'function':
		case 'symbol':
			return undefined;
	}

	const object = value as object;

	if (object instanceof Error) return snapshotErrorObject(object, walk);
	guard(object, walk);
	if (walk.seen.has(object)) return '[Circular]';

	walk.seen.add(object);

	try {
		// As JSON.stringify does, call toJSON once per position and never on its own result, so a
		// toJSON that returns its object is walked through that object's own fields.
		const toJSON = fromToJSON ? undefined : (object as { toJSON?: unknown }).toJSON;

		if (typeof toJSON === 'function') {
			const serialized: unknown = (toJSON as (this: unknown) => unknown).call(object);
			if (serialized !== object) return toPlain(serialized, child(walk), true);
		}

		// Read every value before materializing any, so a nested toJSON or getter cannot change a
		// sibling before it is captured.
		if (Array.isArray(object)) {
			return readItems(object).map((item) => {
				const plain = toPlain(item, child(walk));
				return plain === undefined ? null : plain;
			});
		}

		// Reuse the toJSON read above, so a getter is read once per position.
		const entries = Object.keys(object).map(
			(key) => [key, !fromToJSON && key === 'toJSON' ? toJSON : (object as Record<string, unknown>)[key]] as const
		);

		const result: Record<string, unknown> = {};

		for (const [key, val] of entries) {
			const plain = toPlain(val, child(walk, key));
			if (plain !== undefined) result[key] = plain;
		}

		return result;
	} finally {
		walk.seen.delete(object);
	}
}

function start(): Walk {
	return { seen: new WeakSet<object>(), depth: 0, sensitive: false };
}

/**
 * Reads an error once into a fresh plain-data snapshot: the pino-style type, the standard
 * fields, every enumerable own property, and the cause and aggregate-error chains. Getters are
 * resolved, values are materialized to JSON-compatible plain data, and cycles are guarded, so
 * the result shares no reference with the raw error. Throws when the error cannot be inspected
 * completely: content deeper than `MAX_SNAPSHOT_DEPTH`, or a back-reference beneath a sensitive key.
 */
export function snapshotError(error: unknown): Record<string, unknown> {
	const plain = toPlain(error, start());

	if (plain !== null && typeof plain === 'object' && !Array.isArray(plain)) {
		return plain as Record<string, unknown>;
	}

	return { type: typeof error, message: typeof plain === 'string' ? plain : String(error) };
}

/**
 * Materializes an arbitrary value into JSON-compatible plain data, resolving getters and guarding
 * cycles. Throws in the same cases as `snapshotError`.
 */
export function toPlainData(value: unknown): unknown {
	return toPlain(value, start());
}
