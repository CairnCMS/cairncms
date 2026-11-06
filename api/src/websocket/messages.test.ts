import { describe, expect, it } from 'vitest';
import type { ZodIssue } from 'zod';
import { WebSocketItemsMessage } from './messages.js';

type KeyedAction = 'read' | 'update' | 'delete';

const KEYED_ACTIONS: KeyedAction[] = ['read', 'update', 'delete'];

function idsMessage(action: KeyedAction, ids: unknown) {
	return {
		type: 'items',
		collection: 'articles',
		action,
		ids,
		...(action === 'update' ? { data: { title: 'x' } } : {}),
	};
}

function createMessage(data: unknown) {
	return { type: 'items', collection: 'articles', action: 'create', data };
}

function countIssues(issues: ZodIssue[]): number {
	return issues.reduce((total, issue) => {
		const nested =
			issue.code === 'invalid_union' ? issue.unionErrors.reduce((sum, error) => sum + countIssues(error.issues), 0) : 0;

		return total + 1 + nested;
	}, 0);
}

function issueCount(message: unknown): number {
	const result = WebSocketItemsMessage.safeParse(message);
	expect(result.success).toBe(false);
	return result.success ? 0 : countIssues(result.error.issues);
}

describe('WebSocketItemsMessage ids', () => {
	const validIds: [string, unknown[]][] = [
		['strings', ['a', 'b']],
		['numbers', [1, 2]],
		['mixed strings and numbers', ['a', 1]],
		['an empty array', []],
	];

	const invalidIds: [string, unknown][] = [
		['a null element', ['a', null]],
		['an object element', ['a', {}]],
		['a boolean element', [true]],
		['a NaN element', [Number.NaN]],
		['a value that is not an array', 'a'],
		['a sparse array', new Array(1)],
		['an invalid last element only', ['a', 'b', null]],
	];

	describe.each(KEYED_ACTIONS)('on %s', (action) => {
		it.each(validIds)('accepts %s and returns the same ids', (_label, ids) => {
			const parsed = WebSocketItemsMessage.parse(idsMessage(action, ids)) as { ids?: unknown[] };
			expect(parsed.ids).toEqual(ids);
		});

		it.each(invalidIds)('rejects %s', (_label, ids) => {
			expect(WebSocketItemsMessage.safeParse(idsMessage(action, ids)).success).toBe(false);
		});

		it('returns a copy, so sorting the parsed ids leaves the input order unchanged', () => {
			const ids = ['b', 'a'];
			const parsed = WebSocketItemsMessage.parse(idsMessage(action, ids)) as { ids?: unknown[] };

			expect(parsed.ids).not.toBe(ids);
			parsed.ids?.sort();
			expect(ids).toEqual(['b', 'a']);
		});

		it('keeps the same issue count however many ids are invalid', () => {
			const counts = [1, 10, 100].map((size) => issueCount(idsMessage(action, Array(size).fill(null))));
			expect(new Set(counts).size).toBe(1);
		});
	});
});

describe('WebSocketItemsMessage create data', () => {
	it('accepts an array of plain objects and returns the same items', () => {
		const data = [{ title: 'a' }, { title: 'b' }];
		const parsed = WebSocketItemsMessage.parse(createMessage(data)) as { data?: unknown };
		expect(parsed.data).toEqual(data);
	});

	it('accepts a single plain object', () => {
		const parsed = WebSocketItemsMessage.parse(createMessage({ title: 'a' })) as { data?: unknown };
		expect(parsed.data).toEqual({ title: 'a' });
	});

	const invalidData: [string, unknown][] = [
		['a string element', [{ title: 'a' }, 'x']],
		['a null element', [null]],
		['an array element', [[]]],
		['a sparse array', new Array(1)],
		['an invalid last element only', [{ title: 'a' }, { title: 'b' }, 'x']],
	];

	it.each(invalidData)('rejects an array with %s', (_label, data) => {
		expect(WebSocketItemsMessage.safeParse(createMessage(data)).success).toBe(false);
	});

	it('returns a copy of the array, so reordering it leaves the input unchanged', () => {
		const first = { title: 'a' };
		const second = { title: 'b' };
		const data = [first, second];
		const parsed = WebSocketItemsMessage.parse(createMessage(data)) as { data?: unknown[] };

		expect(parsed.data).not.toBe(data);
		parsed.data?.reverse();
		expect(data).toEqual([first, second]);
	});

	it('keeps the same issue count however many entries are invalid', () => {
		const counts = [1, 10, 100].map((size) => issueCount(createMessage(Array(size).fill(null))));
		expect(new Set(counts).size).toBe(1);
	});
});
