import { InvalidPayloadException, InvalidQueryException } from '@cairncms/exceptions';
import type { Accountability, Filter, Query, SchemaOverview } from '@cairncms/types';
import { optionToObject, toArray } from '@cairncms/utils';
import type { Knex } from 'knex';
import { isPlainObject } from 'lodash-es';
import { InvalidConfigException } from '../exceptions/index.js';
import { AuthorizationService } from '../services/authorization.js';
import { applyFilter } from './apply-query.js';
import getASTFromQuery from './get-ast-from-query.js';
import { sanitizeQuery } from './sanitize-query.js';
import { getConfiguredLimitSchema } from './validate-query.js';

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

export function resolveKeySelection(resolved: unknown): unknown[] {
	const keys = toArray(resolved);

	if (keys.length === 0 || (keys.length === 1 && Array.isArray(keys[0]) && keys[0].length === 0)) return [];

	let usable = false;

	for (const key of keys) {
		const kind = Array.isArray(key) ? classifyNestedKeys(key) : classifyKey(key);
		if (kind === 'invalid') throw missingKeysError();
		if (kind === 'usable') usable = true;
	}

	if (!usable) throw missingKeysError();
	return keys;
}

export function decodeQueryOption(query: unknown, stored: StoredQuery): unknown {
	if (stored === 'none' || query === undefined || query === null) return {};
	if (typeof query === 'string' && query.trim() === '') return {};
	return optionToObject(query);
}

export function requireQuerySelection(query: unknown): { filterOnly: boolean } {
	if (!isPlainObject(query)) throw noTargetError();
	const raw = query as Record<string, unknown>;

	// The sanitizer caps only `-1`, so any supplied limit is validated whatever else selects.
	if (raw['limit'] !== undefined && raw['limit'] !== null) {
		const { error } = getConfiguredLimitSchema().validate(raw['limit']);
		if (error) throw new InvalidQueryException(error.message);
		return { filterOnly: false };
	}

	if (typeof raw['search'] === 'string' && raw['search'].length > 0) return { filterOnly: false };

	const filter = sanitizeQuery({ filter: raw['filter'] } as Query, null).filter;
	if (filter && Object.keys(filter).length > 0) return { filterOnly: true };

	throw noTargetError();
}

/** Checks field permissions before compiling, as reads do, so a refusal never reveals schema details ahead of them. */
export async function requireFilterCondition(
	collection: string,
	filter: Filter | null | undefined,
	context: { schema: SchemaOverview; accountability: Accountability | null; knex: Knex }
): Promise<void> {
	if (!filter) throw noTargetError();

	// An unknown collection is left for the items service to report, as it does for any other step.
	const primary = context.schema.collections?.[collection]?.primary;
	if (!primary) return;

	if (context.accountability && context.accountability.admin !== true) {
		const ast = await getASTFromQuery(collection, { filter, fields: [primary] }, context.schema, {
			accountability: context.accountability,
			knex: context.knex,
		});

		await new AuthorizationService({
			accountability: context.accountability,
			knex: context.knex,
			schema: context.schema,
		}).processAST(ast, 'read');
	}

	const select = context.knex.select(`${collection}.${primary}`).from(collection);
	applyFilter(context.knex, context.schema, select, filter, collection, {});

	if (select.toSQL().sql === select.clone().clear('where').toSQL().sql) throw noTargetError();
}

function classifyKey(value: unknown): 'usable' | 'missing' | 'invalid' {
	if (value === undefined || value === null || value === '') return 'missing';

	if ((typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value))) {
		return 'usable';
	}

	return 'invalid';
}

function classifyNestedKeys(values: unknown[]): 'usable' | 'missing' | 'invalid' {
	let usable = false;

	for (const value of values) {
		const kind = classifyKey(value);
		if (kind === 'invalid') return 'invalid';
		if (kind === 'usable') usable = true;
	}

	return usable ? 'usable' : 'missing';
}

function missingKeysError() {
	return new InvalidPayloadException("The record keys for this step don't contain a usable string or numeric ID.");
}

function noTargetError() {
	return new InvalidConfigException(
		'This step needs record keys, a filter, a search or a limit to choose which items to change.'
	);
}

function isEmptyObject(value: unknown): boolean {
	return isPlainObject(value) && Object.keys(value as Record<string, unknown>).length === 0;
}
