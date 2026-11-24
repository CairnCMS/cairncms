import { describe, expect, test } from 'vitest';
import {
	classifyStoredKey,
	classifyStoredQuery,
	classifyStoredQueryColumn,
	readStoredTargets,
} from './operation-targets.js';

describe('classifyStoredKey', () => {
	test.each([undefined, null, '', []])('treats %j as no key', (value) => {
		expect(classifyStoredKey(value)).toBe('none');
	});

	test.each([0, 5, '5', '1,2', '{{ $trigger.body.id }}', ['{{ $trigger.body.id }}'], [0], ['5', '6']])(
		'treats %j as a configured key',
		(value) => {
			expect(classifyStoredKey(value)).toBe('configured');
		}
	);

	test.each([{}, { id: 5 }, true, false])('treats %j as a malformed key', (value) => {
		expect(classifyStoredKey(value)).toBe('malformed');
	});
});

describe('classifyStoredQuery', () => {
	test.each([undefined, null, '', '   ', {}, '{}', ' { } ', '\n{\t}\r\n'])('treats %j as no query', (value) => {
		expect(classifyStoredQuery(value)).toBe('none');
	});

	test.each([
		{ filter: { status: { _eq: 'paid' } } },
		{ limit: 2 },
		'{"limit": 2}',
		'{{ $trigger.body.query }}',
		'not json',
	])('treats %j as a configured query', (value) => {
		expect(classifyStoredQuery(value)).toBe('configured');
	});

	test('treats a query whose only member is __proto__ as configured, in text and object form', () => {
		const text = '{"__proto__": {"filter": {"paid": {"_eq": true}}}}';

		expect(classifyStoredQuery(text)).toBe('configured');
		expect(classifyStoredQuery(JSON.parse(text))).toBe('configured');
	});
});

describe('classifyStoredQueryColumn', () => {
	const protoOnly = '{"key": [5], "query": {"__proto__": {"filter": {"paid": {"_eq": true}}}}}';

	test('keeps a query whose only member is __proto__ configured in a text column', () => {
		expect(classifyStoredQueryColumn(protoOnly)).toBe('configured');
	});

	test('keeps a query whose only member is __proto__ configured in a parsed column', () => {
		expect(classifyStoredQueryColumn(JSON.parse(protoOnly))).toBe('configured');
	});

	test.each([
		'{"key": [5]}',
		'{"key": [5], "query": {}}',
		'{"key": [5], "query": "{ }"}',
		'{"__proto__": {"query": {"limit": 2}}}',
		'not json',
		null,
	])('treats %j as having no saved query', (column) => {
		expect(classifyStoredQueryColumn(column)).toBe('none');
	});

	test('reads a query saved as text inside the column', () => {
		expect(classifyStoredQueryColumn('{"query": "{\\"limit\\": 2}"}')).toBe('configured');
	});
});

describe('readStoredTargets', () => {
	test.each(['item-update', 'item-delete'])(
		'%s refuses a key when the raw column saved a query that sanitizing removed',
		(type) => {
			expect(() => readStoredTargets(type, { key: [5], query: {} }, 'configured')).toThrow(
				expect.objectContaining({ code: 'INVALID_CONFIG' })
			);
		}
	);

	test.each(['item-read', 'item-update', 'item-delete'])('%s refuses a malformed key', (type) => {
		expect(() => readStoredTargets(type, { key: { id: 5 } })).toThrow(
			expect.objectContaining({ code: 'INVALID_CONFIG' })
		);
	});

	test.each(['item-update', 'item-delete'])('%s refuses a key saved with a query', (type) => {
		expect(() =>
			readStoredTargets(type, { key: ['{{ $trigger.body.ids }}'], query: '{{ $trigger.body.query }}' })
		).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
	});

	test.each(['item-update', 'item-delete'])(
		'%s refuses a key saved with a query whose only member is __proto__',
		(type) => {
			const text = '{"__proto__": {"filter": {"paid": {"_eq": true}}}}';

			for (const query of [text, JSON.parse(text)]) {
				expect(() => readStoredTargets(type, { key: [5], query })).toThrow(
					expect.objectContaining({ code: 'INVALID_CONFIG' })
				);
			}
		}
	);

	test('item-read accepts a key saved with a query', () => {
		expect(readStoredTargets('item-read', { key: [5], query: { fields: ['name'] } })).toEqual({
			key: 'configured',
			query: 'configured',
		});
	});

	test.each(['item-update', 'item-delete'])('%s accepts a key with an empty saved query', (type) => {
		expect(readStoredTargets(type, { key: [5], query: '{}' })).toEqual({ key: 'configured', query: 'none' });
	});

	test('reads a step with neither as no key and no query', () => {
		expect(readStoredTargets('item-delete', {})).toEqual({ key: 'none', query: 'none' });
		expect(readStoredTargets('item-delete', null)).toEqual({ key: 'none', query: 'none' });
	});
});
