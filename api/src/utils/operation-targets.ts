import { isPlainObject } from 'lodash-es';
import { InvalidConfigException } from '../exceptions/index.js';

export type StoredKey = 'configured' | 'none' | 'malformed';

export type StoredQuery = 'configured' | 'none';

export type StoredTargets = { key: Exclude<StoredKey, 'malformed'>; query: StoredQuery };

const SINGLE_TARGET_OPERATION_TYPES: ReadonlySet<string> = new Set(['item-update', 'item-delete']);

const EMPTY_OBJECT_TEXT = /^[ \t\n\r]*\{[ \t\n\r]*\}[ \t\n\r]*$/;

export function classifyStoredKey(value: unknown): StoredKey {
	if (value === undefined || value === null || value === '') return 'none';
	if (Array.isArray(value)) return value.length === 0 ? 'none' : 'configured';
	if (typeof value === 'string' || typeof value === 'number') return 'configured';
	return 'malformed';
}

export function classifyStoredQuery(value: unknown): StoredQuery {
	if (value === undefined || value === null) return 'none';

	if (typeof value === 'string') {
		return value.trim() === '' || EMPTY_OBJECT_TEXT.test(value) ? 'none' : 'configured';
	}

	return isEmptyObject(value) ? 'none' : 'configured';
}

export function classifyStoredQueryColumn(column: unknown): StoredQuery {
	let options: unknown = column;

	if (typeof column === 'string') {
		try {
			// Not the shared parser: it drops `__proto__` members, which can erase a saved Query's only member.
			options = JSON.parse(column);
		} catch {
			return 'none';
		}
	}

	if (!isPlainObject(options) || !Object.prototype.hasOwnProperty.call(options, 'query')) return 'none';
	return classifyStoredQuery((options as Record<string, unknown>)['query']);
}

export function readStoredTargets(
	type: string,
	options: Record<string, unknown> | null | undefined,
	savedQuery?: StoredQuery
): StoredTargets {
	const key = classifyStoredKey(options?.['key']);

	if (key === 'malformed') {
		throw new InvalidConfigException("This step's record keys are not a value, a list or a reference.");
	}

	const query = savedQuery ?? classifyStoredQuery(options?.['query']);

	if (key === 'configured' && query === 'configured' && SINGLE_TARGET_OPERATION_TYPES.has(type)) {
		throw new InvalidConfigException(
			"This step has both record keys and a query. Remove the query, or move the keys into the query's filter."
		);
	}

	return { key, query };
}

function isEmptyObject(value: unknown): boolean {
	return isPlainObject(value) && Object.keys(value as Record<string, unknown>).length === 0;
}
