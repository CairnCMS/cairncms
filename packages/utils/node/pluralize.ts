import type { Plural } from '@cairncms/types';

export function pluralize<T extends string>(str: T): Plural<T> {
	return `${str}s`;
}

export function depluralize<T extends string>(str: Plural<T>): T {
	return str.slice(0, -1) as T;
}

/**
 * The pluralized form of a type as a valid JS identifier, for generated code that
 * declares per-type arrays. A hyphenated type like item-view pluralizes to item-views,
 * which is a legal object key but not a legal identifier, so generators declare
 * itemViews and alias the export back to the canonical key.
 */
export function pluralizeToIdentifier<T extends string>(str: T): string {
	return pluralize(str).replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}
