import type { Filter, Permission } from '@cairncms/types';
import { describe, expect, test } from 'vitest';
import { mergePermission, mergePermissions } from './merge-permissions.js';

const fullFilter = {} as Filter;
const conditionalFilter = { user: { id: { _eq: '$CURRENT_USER' } } } as Filter;
const conditionalFilter2 = { count: { _gt: 42 } } as Filter;

const permissionTemplate = {
	role: null,
	collection: 'directus_users',
	permissions: null,
	validation: null,
	presets: null,
	fields: null,
} as Permission;

describe('merging permissions', () => {
	test('processes _or permissions', () => {
		const mergedPermission = mergePermission(
			'or',
			{ ...permissionTemplate, permissions: conditionalFilter },
			{ ...permissionTemplate, permissions: conditionalFilter2 }
		);

		expect(mergedPermission).toStrictEqual({
			...permissionTemplate,
			permissions: {
				_or: [conditionalFilter, conditionalFilter2],
			},
		});
	});

	test('composes non-empty validations with _and under _or strategy', () => {
		const mergedPermission = mergePermission(
			'or',
			{ ...permissionTemplate, validation: conditionalFilter },
			{ ...permissionTemplate, validation: conditionalFilter2 }
		);

		expect(mergedPermission).toStrictEqual({
			...permissionTemplate,
			validation: {
				_and: [conditionalFilter, conditionalFilter2],
			},
		});
	});

	test('processes _and permissions', () => {
		const mergedPermission = mergePermission(
			'and',
			{ ...permissionTemplate, permissions: conditionalFilter },
			{ ...permissionTemplate, permissions: conditionalFilter2 }
		);

		expect(mergedPermission).toStrictEqual({
			...permissionTemplate,
			permissions: {
				_and: [conditionalFilter, conditionalFilter2],
			},
		});
	});

	test('processes _and validations', () => {
		const mergedPermission = mergePermission(
			'and',
			{ ...permissionTemplate, validation: conditionalFilter },
			{ ...permissionTemplate, validation: conditionalFilter2 }
		);

		expect(mergedPermission).toStrictEqual({
			...permissionTemplate,
			validation: {
				_and: [conditionalFilter, conditionalFilter2],
			},
		});
	});

	test('{} supersedes conditional permissions in _or', () => {
		const mergedPermission = mergePermission(
			'or',
			{ ...permissionTemplate, permissions: fullFilter },
			{ ...permissionTemplate, permissions: conditionalFilter }
		);

		expect(mergedPermission).toStrictEqual({ ...permissionTemplate, permissions: fullFilter });
	});

	test('{} does not supersede conditional permissions in _and', () => {
		const mergedPermission = mergePermission(
			'and',
			{ ...permissionTemplate, permissions: fullFilter },
			{ ...permissionTemplate, permissions: conditionalFilter }
		);

		const expectedPermission = {
			...permissionTemplate,
			permissions: {
				_and: [fullFilter, conditionalFilter],
			},
		};

		expect(mergedPermission).toStrictEqual(expectedPermission);
	});

	test('{} validation contributes nothing under _and strategy', () => {
		const mergedPermission = mergePermission(
			'and',
			{ ...permissionTemplate, validation: fullFilter },
			{ ...permissionTemplate, validation: conditionalFilter }
		);

		expect(mergedPermission).toStrictEqual({ ...permissionTemplate, validation: conditionalFilter });
	});

	test('null validation contributes nothing under _or strategy', () => {
		const mergedPermission = mergePermission(
			'or',
			{ ...permissionTemplate, validation: conditionalFilter },
			{ ...permissionTemplate, validation: null }
		);

		expect(mergedPermission).toStrictEqual({ ...permissionTemplate, validation: conditionalFilter });
	});

	test('{} validation contributes nothing under _or strategy', () => {
		const mergedPermission = mergePermission(
			'or',
			{ ...permissionTemplate, validation: conditionalFilter },
			{ ...permissionTemplate, validation: fullFilter }
		);

		expect(mergedPermission).toStrictEqual({ ...permissionTemplate, validation: conditionalFilter });
	});

	test('three-row merge flattens validation _and (no nesting)', () => {
		const a = { user: { _eq: 'a' } } as Filter;
		const b = { status: { _eq: 'published' } } as Filter;
		const c = { tenant_id: { _eq: 't1' } } as Filter;

		const merged = mergePermissions(
			'or',
			[{ ...permissionTemplate, validation: a }],
			[{ ...permissionTemplate, validation: b }],
			[{ ...permissionTemplate, validation: c }]
		);

		expect(merged[0]!.validation).toStrictEqual({ _and: [a, b, c] });
	});

	test('GHSA-3fff regression: baseline validation survives operator row with empty validation under _or', () => {
		const baselineValidation = { user: { _eq: '$CURRENT_USER' } } as Filter;

		const merged = mergePermissions(
			'or',
			[{ ...permissionTemplate, collection: 'directus_presets', action: 'update', validation: fullFilter }],
			[{ ...permissionTemplate, collection: 'directus_presets', action: 'update', validation: baselineValidation }]
		);

		expect(merged[0]!.validation).toStrictEqual(baselineValidation);
	});
});
