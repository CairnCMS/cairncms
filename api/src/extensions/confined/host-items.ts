import type { Accountability, ExtensionCapabilities, Query } from '@cairncms/types';
import { ABORTED, abortable, denied, invalidRequest, timedOut } from './host-reply.js';
import type { ConfinedHostReply } from './types.js';

// The broker maximum, not an operator knob. A requested limit clamps here
// before the service runs, and an absent limit gets it explicitly so the
// effective bound never depends on environment defaults.
export const ITEMS_MAX_LIMIT = 100;

// The row cap bounds the reply, not the seek work, so the effective offset
// (direct, or implied by page times limit) is bounded separately and refused
// over the maximum rather than silently clamped to a different page.
export const ITEMS_MAX_OFFSET = 10_000;

const MAX_COLLECTION_LENGTH = 255;
const MAX_KEY_LENGTH = 255;
const MAX_FIELDS = 64;
const MAX_FIELD_LENGTH = 128;
const MAX_FIELD_DEPTH = 3;
const MAX_SORT_ENTRIES = 8;
const MAX_SEARCH_LENGTH = 256;
const MAX_FILTER_DEPTH = 8;
const MAX_FILTER_NODES = 256;

const FIELD_SEGMENT = /^[A-Za-z0-9_]+$/;

const SUPPORTED_QUERY_KEYS = new Set(['fields', 'filter', 'sort', 'limit', 'offset', 'page', 'search']);

const FILTER_LOGICAL_KEYS = new Set(['_and', '_or']);

// The broker's filter vocabulary, a reviewed subset of the operators the
// platform validator (getFilterOperatorsForType) accepts across field types,
// grouped by the value shape each accepts. An operator outside it refuses
// rather than tunneling to whatever the platform parser would do with it.
const EQUALITY_OPERATORS = new Set(['_eq', '_neq']);
const COMPARISON_OPERATORS = new Set(['_lt', '_lte', '_gt', '_gte']);
const LIST_OPERATORS = new Set(['_in', '_nin']);
const RANGE_OPERATORS = new Set(['_between', '_nbetween']);
const FLAG_OPERATORS = new Set(['_null', '_nnull', '_empty', '_nempty']);

const STRING_OPERATORS = new Set([
	'_contains',
	'_ncontains',
	'_icontains',
	'_starts_with',
	'_nstarts_with',
	'_ends_with',
	'_nends_with',
]);

const FILTER_OPERATORS = new Set([
	...EQUALITY_OPERATORS,
	...COMPARISON_OPERATORS,
	...LIST_OPERATORS,
	...RANGE_OPERATORS,
	...FLAG_OPERATORS,
	...STRING_OPERATORS,
]);

const MAX_LOGICAL_BRANCHES = 16;
const MAX_OPERATOR_LIST = 100;

/** The read-only slice of the items service the broker consumes. */
export interface ConfinedItemsReader {
	readByQuery(query: Query): Promise<unknown>;
	readOne(key: string | number, query: Query): Promise<unknown>;
}

export type ConfinedItemsServiceFactory = (
	collection: string,
	accountability: Accountability | null
) => ConfinedItemsReader;

export interface ConfinedItemsHostDeps {
	capabilities: ExtensionCapabilities;
	// The invocation's accountability, carried explicitly. Absent and null both
	// deny under current-user, they never fall through to an elevated read.
	accountability?: Accountability | null | undefined;
	itemsService?: ConfinedItemsServiceFactory | undefined;
	itemsReplyBytes: number;
}

type NormalizedQuery = { ok: true; query: Query } | { ok: false; reason: string };

function refuse(reason: string): NormalizedQuery {
	return { ok: false, reason };
}

function isScalar(value: unknown): value is string | number {
	return typeof value === 'string' || typeof value === 'number';
}

/**
 * Per-operator value shapes, because the platform applies values operator-
 * specifically rather than validating them: a range with the wrong arity
 * silently applies no predicate at all (broadening the result), and a
 * non-string under a string operator throws at apply time. The broker refuses
 * every shape the operator does not define.
 */
function validateOperatorValue(operator: string, value: unknown, budget: { nodes: number }): string | null {
	if (LIST_OPERATORS.has(operator)) {
		if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPERATOR_LIST) {
			return 'a list operator needs a bounded non-empty array';
		}

		for (const entry of value) {
			budget.nodes -= 1;
			if (budget.nodes <= 0) return 'the filter has too many nodes';
			if (!isScalar(entry)) return 'a list operator accepts only strings and numbers';
		}

		return null;
	}

	if (RANGE_OPERATORS.has(operator)) {
		if (!Array.isArray(value) || value.length !== 2) return 'a range operator needs exactly two values';
		if (!value.every(isScalar)) return 'a range operator accepts only strings and numbers';
		return null;
	}

	if (FLAG_OPERATORS.has(operator)) {
		return typeof value === 'boolean' ? null : 'a presence operator needs a boolean';
	}

	if (STRING_OPERATORS.has(operator)) {
		return typeof value === 'string' ? null : 'a string operator needs a string';
	}

	if (COMPARISON_OPERATORS.has(operator)) {
		return isScalar(value) ? null : 'a comparison operator needs a string or a number';
	}

	if (isScalar(value) || typeof value === 'boolean') return null;

	return 'an equality operator needs a string, a number, or a boolean';
}

/**
 * The broker's filter grammar mirrors what the platform's path derivation can
 * actually apply. At the root and inside logical branches, keys are bounded
 * logical groups or field segments, several side by side (implicit and). A
 * field's value object carries EXACTLY one key, an allowlisted operator or one
 * nested field segment, because the platform follows only the first child when
 * deriving the filter path: sibling predicates and sibling operators under one
 * field are silently dropped, and a field-scoped logical degenerates into a
 * nonsense equality. Multiple conditions on one relation are written as a
 * logical group of single-path branches instead.
 */
function validateFilterContext(value: unknown, depth: number, budget: { nodes: number }): string | null {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		return 'the filter contains an unsupported value';
	}

	if (depth >= MAX_FILTER_DEPTH) return 'the filter is too deeply nested';

	for (const [key, entry] of Object.entries(value)) {
		budget.nodes -= 1;
		if (budget.nodes <= 0) return 'the filter has too many nodes';

		if (FILTER_LOGICAL_KEYS.has(key)) {
			if (!Array.isArray(entry) || entry.length === 0 || entry.length > MAX_LOGICAL_BRANCHES) {
				return 'a logical filter must be a bounded non-empty array';
			}

			for (const branch of entry) {
				const reason = validateFilterContext(branch, depth + 1, budget);
				if (reason !== null) return reason;

				if (Object.keys(branch as Record<string, unknown>).length === 0) {
					return 'a logical filter branch must not be empty';
				}
			}
		} else if (key.startsWith('_')) {
			return 'a filter operator must apply to a field';
		} else {
			if (key.length > MAX_FIELD_LENGTH || !FIELD_SEGMENT.test(key)) {
				return 'a filter field has an unsupported segment';
			}

			const reason = validateFieldValue(entry, depth + 1, budget);
			if (reason !== null) return reason;
		}
	}

	return null;
}

function validateFieldValue(value: unknown, depth: number, budget: { nodes: number }): string | null {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		return 'the filter contains an unsupported value';
	}

	if (depth >= MAX_FILTER_DEPTH) return 'the filter is too deeply nested';

	const entries = Object.entries(value);
	if (entries.length !== 1) return 'a field filter needs exactly one operator or one nested field';

	const [key, entry] = entries[0]!;

	budget.nodes -= 1;
	if (budget.nodes <= 0) return 'the filter has too many nodes';

	if (FILTER_LOGICAL_KEYS.has(key)) return 'a logical filter cannot scope a field';

	if (key.startsWith('_')) {
		if (!FILTER_OPERATORS.has(key)) return `the filter operator "${key}" is not supported`;
		return validateOperatorValue(key, entry, budget);
	}

	if (key.length > MAX_FIELD_LENGTH || !FIELD_SEGMENT.test(key)) {
		return 'a filter field has an unsupported segment';
	}

	return validateFieldValue(entry, depth + 1, budget);
}

function validateFieldPath(path: string): string | null {
	if (path.length === 0 || path.length > MAX_FIELD_LENGTH) return 'a field entry is empty or too long';
	if (path === '*') return null;

	const segments = path.split('.');
	if (segments.length > MAX_FIELD_DEPTH) return 'a field entry is too deeply nested';

	for (const segment of segments) {
		// A wildcard inside a path is a deep relational expansion, rejected rather
		// than passed through to whatever the platform would expand it to.
		if (!FIELD_SEGMENT.test(segment)) return 'a field entry has an unsupported segment';
	}

	return null;
}

function validateSortEntry(entry: string): string | null {
	if (entry.length === 0 || entry.length > MAX_FIELD_LENGTH) return 'a sort entry is empty or too long';

	const path = entry.startsWith('-') ? entry.slice(1) : entry;
	if (path.length === 0) return 'a sort entry is empty or too long';
	if (path === '*') return 'a sort entry has an unsupported segment';

	const segments = path.split('.');
	if (segments.length > MAX_FIELD_DEPTH) return 'a sort entry is too deeply nested';

	for (const segment of segments) {
		if (!FIELD_SEGMENT.test(segment)) return 'a sort entry has an unsupported segment';
	}

	return null;
}

/**
 * Builds a new query object from the supported author-contract keys and
 * refuses, never strips, everything else. The author type is documentation
 * while the guest sends arbitrary JSON, and the transport reply cap bites only
 * after the database work has already happened, so unsupported platform query
 * features (deep, alias, aggregate, groupBy, export, or anything unknown) must
 * not tunnel through, and the limit is always explicit and clamped.
 */
export function normalizeItemsQuery(raw: unknown): NormalizedQuery {
	if (raw === undefined || raw === null) return { ok: true, query: { limit: ITEMS_MAX_LIMIT } };

	if (typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
		return refuse('the query must be an object');
	}

	const record = raw as Record<string, unknown>;
	const query: Query = { limit: ITEMS_MAX_LIMIT };

	for (const [key, value] of Object.entries(record)) {
		if (!SUPPORTED_QUERY_KEYS.has(key)) return refuse(`the query key "${key}" is not supported`);
		if (value === undefined) continue;

		if (key === 'fields') {
			if (!Array.isArray(value) || value.length > MAX_FIELDS) return refuse('fields must be a bounded array');

			for (const entry of value) {
				if (typeof entry !== 'string') return refuse('fields must contain only strings');
				const reason = validateFieldPath(entry);
				if (reason !== null) return refuse(reason);
			}

			query.fields = [...value] as string[];
		} else if (key === 'sort') {
			if (!Array.isArray(value) || value.length > MAX_SORT_ENTRIES) return refuse('sort must be a bounded array');

			for (const entry of value) {
				if (typeof entry !== 'string') return refuse('sort must contain only strings');
				const reason = validateSortEntry(entry);
				if (reason !== null) return refuse(reason);
			}

			query.sort = [...value] as string[];
		} else if (key === 'limit') {
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
				return refuse('limit must be a positive integer');
			}

			query.limit = Math.min(value, ITEMS_MAX_LIMIT);
		} else if (key === 'offset') {
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
				return refuse('offset must be a non-negative integer');
			}

			query.offset = value;
		} else if (key === 'page') {
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
				return refuse('page must be a non-negative integer');
			}

			query.page = value;
		} else if (key === 'search') {
			if (typeof value !== 'string' || value.length > MAX_SEARCH_LENGTH) {
				return refuse('search must be a bounded string');
			}

			query.search = value;
		} else if (key === 'filter') {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				return refuse('filter must be an object');
			}

			const reason = validateFilterContext(value, 0, { nodes: MAX_FILTER_NODES });
			if (reason !== null) return refuse(reason);

			query.filter = value as NonNullable<Query['filter']>;
		}
	}

	if (typeof query.offset === 'number' && query.offset > ITEMS_MAX_OFFSET) {
		return refuse('offset exceeds the broker maximum');
	}

	if (typeof query.page === 'number' && query.page > 0) {
		const implied = (query.page - 1) * (query.limit ?? ITEMS_MAX_LIMIT);
		if (implied > ITEMS_MAX_OFFSET) return refuse('page exceeds the broker maximum');
	}

	return { ok: true, query };
}

function isForbidden(error: unknown): boolean {
	return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'FORBIDDEN';
}

export interface ConfinedItemsHost {
	read(args: unknown, signal: AbortSignal): Promise<ConfinedHostReply>;
	readOne(args: unknown, signal: AbortSignal): Promise<ConfinedHostReply>;
}

/**
 * Read-first platform data access under the authority model. The capability is
 * the accountability mode alone: current-user reads as the invocation's caller
 * and denies without one, system is the catalogued elevated opt-in. The
 * permission layer stays the authority, the broker only refuses to construct
 * the service under an authority the capability does not declare.
 */
export function createConfinedItemsHost(deps: ConfinedItemsHostDeps): ConfinedItemsHost {
	function resolveAuthority():
		| { ok: true; accountability: Accountability | null }
		| { ok: false; reply: ConfinedHostReply } {
		const mode = deps.capabilities.items;

		if (mode === undefined) return { ok: false, reply: denied('the items capability is not declared') };

		if (mode === 'current-user') {
			const accountability = deps.accountability;

			if (accountability === undefined || accountability === null) {
				return { ok: false, reply: denied('the invocation has no accountability') };
			}

			return { ok: true, accountability };
		}

		if (mode === 'system') return { ok: true, accountability: null };

		return { ok: false, reply: denied('the items capability is not declared') };
	}

	function readCollection(
		record: Record<string, unknown>
	): { ok: true; collection: string } | { ok: false; reply: ConfinedHostReply } {
		const collection = record['collection'];

		if (typeof collection !== 'string' || collection.length === 0 || collection.length > MAX_COLLECTION_LENGTH) {
			return { ok: false, reply: invalidRequest('the collection must be a non-empty string') };
		}

		return { ok: true, collection };
	}

	function shapeReply(value: unknown): ConfinedHostReply {
		let serialized: string;

		try {
			serialized = JSON.stringify(value) ?? 'null';
		} catch {
			return { ok: false, error: { code: 'internal', message: 'the items read failed' } };
		}

		if (Buffer.byteLength(serialized, 'utf8') > deps.itemsReplyBytes) {
			return invalidRequest('the items reply exceeds the reply cap');
		}

		return { ok: true, value: JSON.parse(serialized) };
	}

	type PreparedRead =
		| { ok: true; run: (reader: ConfinedItemsReader, query: Query) => Promise<unknown>; forbidden: ConfinedHostReply }
		| { ok: false; reply: ConfinedHostReply };

	async function serve(
		args: unknown,
		signal: AbortSignal,
		prepare: (record: Record<string, unknown>) => PreparedRead
	): Promise<ConfinedHostReply> {
		const authority = resolveAuthority();
		if (!authority.ok) return authority.reply;

		if (deps.itemsService === undefined) return denied('brokered items access is not available');

		const record = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};

		const collection = readCollection(record);
		if (!collection.ok) return collection.reply;

		const prepared = prepare(record);
		if (!prepared.ok) return prepared.reply;

		const normalized = normalizeItemsQuery(record['query']);
		if (!normalized.ok) return invalidRequest(normalized.reason);

		let value: unknown;

		try {
			const reader = deps.itemsService(collection.collection, authority.accountability);
			const result = await abortable(prepared.run(reader, normalized.query), signal);
			if (result === ABORTED) return timedOut();
			value = result;
		} catch (error) {
			if (isForbidden(error)) return prepared.forbidden;
			return { ok: false, error: { code: 'internal', message: 'the items read failed' } };
		}

		return shapeReply(value);
	}

	return {
		read(args, signal) {
			return serve(args, signal, () => ({
				ok: true,
				run: (reader, query) => reader.readByQuery(query),
				forbidden: denied('the read was denied'),
			}));
		},

		readOne(args, signal) {
			return serve(args, signal, (record) => {
				const key = record['key'];

				const validKey =
					(typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH) ||
					(typeof key === 'number' && Number.isSafeInteger(key));

				if (!validKey) {
					return { ok: false, reply: invalidRequest('the key must be a non-empty string or an integer') };
				}

				// Forbidden and missing collapse to the same null, the permission
				// layer's non-leak semantic carried through the broker.
				return {
					ok: true,
					run: (reader, query) => reader.readOne(key as string | number, query),
					forbidden: { ok: true, value: null },
				};
			});
		},
	};
}
