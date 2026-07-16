const MAX_SNAPSHOT_DEPTH = 64;

const STANDARD_ERROR_FIELDS = ['message', 'stack', 'cause', 'originalError', 'errors'] as const;

function snapshotErrorObject(error: object, seen: WeakSet<object>, depth: number): Record<string, unknown> {
	if (depth > MAX_SNAPSHOT_DEPTH) return { type: '[Max depth exceeded]' };
	if (seen.has(error)) return { type: '[Circular]' };
	seen.add(error);

	try {
		// Read each property once: enumerable own props, then the standard non-enumerable
		// error fields Object.entries misses.
		const fields = new Map<string, unknown>();

		for (const [key, val] of Object.entries(error)) fields.set(key, val);

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
				result['aggregateErrors'] = val.map((item) => toPlain(item, seen, depth + 1));
				continue;
			}

			if (key in result) continue;

			const plain = toPlain(val, seen, depth + 1);
			if (plain !== undefined) result[key] = plain;
		}

		return result;
	} finally {
		seen.delete(error);
	}
}

function toPlain(value: unknown, seen: WeakSet<object>, depth: number): unknown {
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

	if (object instanceof Error) return snapshotErrorObject(object, seen, depth);
	if (depth > MAX_SNAPSHOT_DEPTH) return '[Max depth exceeded]';
	if (seen.has(object)) return '[Circular]';

	seen.add(object);

	try {
		const toJSON = (object as { toJSON?: unknown }).toJSON;

		if (typeof toJSON === 'function') {
			return toPlain((toJSON as (this: unknown) => unknown).call(object), seen, depth + 1);
		}

		if (Array.isArray(object)) {
			return object.map((item) => {
				const plain = toPlain(item, seen, depth + 1);
				return plain === undefined ? null : plain;
			});
		}

		const result: Record<string, unknown> = {};

		for (const [key, val] of Object.entries(object)) {
			const plain = toPlain(val, seen, depth + 1);
			if (plain !== undefined) result[key] = plain;
		}

		return result;
	} finally {
		seen.delete(object);
	}
}

/**
 * Reads an error once into a fresh plain-data snapshot: the pino-style type, the standard
 * fields, every enumerable own property, and the cause, originalError, and aggregate-error
 * chains. Getters are resolved, values are materialized to JSON-compatible plain data, and
 * cycles are guarded, so the result shares no reference with the raw error.
 */
export function snapshotError(error: unknown): Record<string, unknown> {
	const plain = toPlain(error, new WeakSet<object>(), 0);

	if (plain !== null && typeof plain === 'object' && !Array.isArray(plain)) {
		return plain as Record<string, unknown>;
	}

	return { type: typeof error, message: typeof plain === 'string' ? plain : String(error) };
}

/** Materializes an arbitrary value into JSON-compatible plain data, resolving getters and guarding cycles. */
export function toPlainData(value: unknown): unknown {
	return toPlain(value, new WeakSet<object>(), 0);
}
