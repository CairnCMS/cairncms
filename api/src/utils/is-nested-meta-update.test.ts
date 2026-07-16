import type { Diff } from 'deep-diff';
import { describe, expect, it } from 'vitest';

import { isNestedMetaUpdate } from './is-nested-meta-update.js';

describe('isNestedMetaUpdate', () => {
	it.each([
		{ kind: 'E', path: ['meta', 'options', 'option_a'], rhs: {} },
		{ kind: 'A', path: ['meta', 'options', 'option_a'], rhs: [] },
	] as Diff<unknown>[])('Returns false when diff is kind $kind', (diff) => {
		expect(isNestedMetaUpdate(diff)).toBe(false);
	});

	it.each([
		{ kind: 'N', path: ['schema', 'default_value'], rhs: {} },
		{ kind: 'D', path: ['schema'], lhs: {} },
	] as Diff<unknown>[])('Returns false when diff path is not nested in meta', (diff) => {
		expect(isNestedMetaUpdate(diff)).toBe(false);
	});

	it.each([
		{ kind: 'N', rhs: { collection: 'articles' } },
		{ kind: 'D', lhs: { collection: 'articles' } },
	] as Diff<unknown>[])('Returns false for a whole-entity create/delete with no path (kind $kind)', (diff) => {
		expect(isNestedMetaUpdate(diff)).toBe(false);
	});

	it('Returns false for an undefined diff', () => {
		expect(isNestedMetaUpdate(undefined)).toBe(false);
	});

	it.each([
		{ kind: 'N', path: ['meta', 'options', 'option_a'], rhs: { test: 'value' } },
		{ kind: 'D', path: ['meta', 'options', 'option_b'], lhs: {} },
		{ kind: 'N', path: ['meta', 'group'], rhs: 'parent' },
		{ kind: 'D', path: ['meta', 'sort_field'], lhs: 'sort' },
	] as Diff<unknown>[])('Returns true when diff path is nested in meta (kind $kind, $path)', (diff) => {
		expect(isNestedMetaUpdate(diff)).toBe(true);
	});
});
