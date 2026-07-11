import type { Plural } from '@cairncms/types';

export function pluralize<T extends string>(str: T): Plural<T> {
	return `${str}s`;
}

export function depluralize<T extends string>(str: Plural<T>): T {
	return str.slice(0, -1) as T;
}

/**
 * The pluralized type as a valid JS identifier: item-view pluralizes to item-views,
 * a legal object key but not a legal identifier in generated declarations.
 */
export function pluralizeToIdentifier<T extends string>(str: T): string {
	return pluralize(str).replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}
