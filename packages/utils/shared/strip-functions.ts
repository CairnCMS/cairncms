/**
 * Replace functions with `undefined` so the value can cross an isolated-vm boundary.
 */
export function stripFunctions<T>(value: T): T {
	return strip(value, new WeakMap()) as T;
}

function strip(value: unknown, seen: WeakMap<object, unknown>): unknown {
	if (typeof value === 'function') return undefined;
	if (value === null || typeof value !== 'object') return value;

	if (
		value instanceof Date ||
		value instanceof RegExp ||
		value instanceof Map ||
		value instanceof Set ||
		value instanceof Error ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value)
	) {
		return value;
	}

	if (seen.has(value)) return seen.get(value);

	if (Array.isArray(value)) {
		const out: unknown[] = [];
		seen.set(value, out);

		for (const item of value) {
			out.push(strip(item, seen));
		}

		return out;
	}

	const out: Record<string, unknown> = {};
	seen.set(value, out);

	for (const key of Object.keys(value as Record<string, unknown>)) {
		out[key] = strip((value as Record<string, unknown>)[key], seen);
	}

	return out;
}
