import type { Diff } from 'deep-diff';
import { describe, expect, it } from 'vitest';
import { schemaDiffOperation } from './schema-diff-operation.js';

describe('schemaDiffOperation', () => {
	it.each([
		[[{ kind: 'N', rhs: { field: 'title' } }]],
		[
			[
				{ kind: 'N', rhs: { field: 'title' } },
				{ kind: 'D', path: ['meta'], lhs: null },
			],
		],
	] as Diff<unknown>[][][])('classifies a diff starting with a whole-entity new entry as a create', (diff) => {
		expect(schemaDiffOperation(diff)).toBe('create');
	});

	it.each([
		[[{ kind: 'D', lhs: { field: 'title' } }]],
		[
			[
				{ kind: 'D', lhs: { field: 'title' } },
				{ kind: 'E', path: ['type'], lhs: 'string', rhs: 'text' },
			],
		],
	] as Diff<unknown>[][][])('classifies a diff starting with a whole-entity delete as a delete', (diff) => {
		expect(schemaDiffOperation(diff)).toBe('delete');
	});

	it.each([
		['a removed attribute', { kind: 'D', path: ['schema'], lhs: { name: 'title' } }],
		['a removed column property', { kind: 'D', path: ['schema', 'max_length'], lhs: 255 }],
		['a removed metadata property', { kind: 'D', path: ['meta', 'sort_field'], lhs: 'sort' }],
		['an added attribute', { kind: 'N', path: ['meta'], rhs: { note: null } }],
		['an added metadata property', { kind: 'N', path: ['meta', 'note'], rhs: 'Headline' }],
		['an edit', { kind: 'E', path: ['type'], lhs: 'string', rhs: 'text' }],
		['an array change', { kind: 'A', path: ['meta', 'special'], index: 0, item: { kind: 'N', rhs: 'cast-json' } }],
	] as [string, Diff<unknown>][])('classifies a diff starting with %s as an update', (_label, first) => {
		expect(schemaDiffOperation([first])).toBe('update');
		expect(schemaDiffOperation([first, { kind: 'D', lhs: { field: 'title' } } as Diff<unknown>])).toBe('update');
	});
});
