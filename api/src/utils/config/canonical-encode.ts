import { isPlainObject } from 'lodash-es';

/** Orders two strings by UTF-16 code unit, the locale-independent ordering the digest depends on. */
export function compareCodeUnits(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

export type CanonicalToken =
	| ['n']
	| ['u']
	| ['s', string]
	| ['m', number]
	| ['b', boolean]
	| ['a', CanonicalToken[]]
	| ['o', Array<[string, CanonicalToken]>];

/**
 * Encodes a value as a tagged canonical token tree for stable hashing. Object keys are sorted by code unit and
 * array order is preserved as given. A missing key, an `undefined` value, and a `null` value stay distinct. The
 * encoder reads own entries and never assigns to an object key, so an own `__proto__` property is an ordinary
 * entry and cannot pollute a prototype. It fails closed on any value that has no canonical representation.
 */
export function canonicalEncode(value: unknown): CanonicalToken {
	if (value === null) return ['n'];
	if (value === undefined) return ['u'];

	switch (typeof value) {
		case 'string':
			return ['s', value];
		case 'boolean':
			return ['b', value];
		case 'number':
			if (!Number.isFinite(value)) throw new Error('Cannot canonically encode a non-finite number.');
			return ['m', value];
		case 'bigint':
			throw new Error('Cannot canonically encode a bigint.');
		case 'function':
			throw new Error('Cannot canonically encode a function.');
		case 'symbol':
			throw new Error('Cannot canonically encode a symbol.');
	}

	if (Array.isArray(value)) {
		return ['a', value.map((element) => canonicalEncode(element))];
	}

	if (isPlainObject(value)) {
		const entries = Object.entries(value as Record<string, unknown>)
			.map(([key, entryValue]): [string, CanonicalToken] => [key, canonicalEncode(entryValue)])
			.sort((a, b) => compareCodeUnits(a[0], b[0]));

		return ['o', entries];
	}

	throw new Error('Cannot canonically encode a non-plain object.');
}
