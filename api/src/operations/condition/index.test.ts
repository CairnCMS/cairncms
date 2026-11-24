import type { Filter } from '@cairncms/types';
import { describe, expect, test } from 'vitest';

import config from './index.js';

describe('Operations / Condition', () => {
	test('returns null when condition passes', () => {
		const filter = {
			status: {
				_eq: true,
			},
		};

		const data = {
			status: true,
		};

		expect(config.handler({ filter }, { data } as any)).toBe(null);
	});

	test('throws error array when conditions fails', () => {
		const filter = {
			status: {
				_eq: true,
			},
		};

		const data = {
			status: false,
		};

		expect.assertions(3);

		try {
			config.handler({ filter }, { data } as any);
		} catch (err: any) {
			expect(err).toHaveLength(1);
			expect(err[0]!.path).toEqual(['status']);
			expect(err[0]!.type).toBe('any.only');
		}
	});

	test('throws error array when condition is checking for a field that is not included in data', () => {
		const filter = {
			status: {
				_eq: true,
			},
		};

		const data = {};

		expect.assertions(3);

		try {
			config.handler({ filter }, { data } as any);
		} catch (err: any) {
			expect(err).toHaveLength(1);
			expect(err[0]!.path).toEqual(['status']);
			expect(err[0]!.type).toBe('any.required');
		}
	});

	test('thrown error does not contain marker values from $env, $accountability, or $trigger.headers', () => {
		const filter = {
			must_pass: {
				_eq: 'expected',
			},
		};

		const data = {
			must_pass: 'actual',
			$env: { LEAK_PROBE: 'SECRET_MARKER_AAA_DO_NOT_LEAK' },
			$accountability: { user: 'USER_MARKER_BBB_DO_NOT_LEAK' },
			$trigger: { headers: { authorization: 'Bearer TOKEN_MARKER_CCC_DO_NOT_LEAK' } },
		};

		expect.assertions(4);

		try {
			config.handler({ filter }, { data } as any);
		} catch (err: any) {
			const blob = JSON.stringify(err);
			expect(err).toBeDefined();
			expect(blob).not.toContain('SECRET_MARKER_AAA_DO_NOT_LEAK');
			expect(blob).not.toContain('USER_MARKER_BBB_DO_NOT_LEAK');
			expect(blob).not.toContain('TOKEN_MARKER_CCC_DO_NOT_LEAK');
		}
	});

	test('thrown error does not contain the rejected candidate value when the filter operator is _starts_with', () => {
		const filter = {
			some_field: {
				_starts_with: 'expected_prefix_',
			},
		};

		const data = {
			some_field: 'SECRET_CANDIDATE_VALUE_DDD_DO_NOT_LEAK',
		};

		expect.assertions(2);

		try {
			config.handler({ filter }, { data } as any);
		} catch (err: any) {
			const blob = JSON.stringify(err);
			expect(err).toBeDefined();
			expect(blob).not.toContain('SECRET_CANDIDATE_VALUE_DDD_DO_NOT_LEAK');
		}
	});

	test('thrown error does not contain the rejected candidate value when the filter operator is _regex', () => {
		const filter = {
			some_field: {
				_regex: '^expected_prefix_',
			},
		};

		const data = {
			some_field: 'SECRET_CANDIDATE_VALUE_EEE_DO_NOT_LEAK',
		};

		expect.assertions(4);

		try {
			config.handler({ filter }, { data } as any);
		} catch (err: any) {
			const blob = JSON.stringify(err);
			expect(blob).not.toContain('SECRET_CANDIDATE_VALUE_EEE_DO_NOT_LEAK');
			expect(err).toHaveLength(1);
			expect(err[0]!.path).toEqual(['some_field']);
			expect(err[0]!.type).toBe('string.pattern.base');
		}
	});

	test.each([
		['_contains', 'abc', 'xyz', 'string.contains'],
		['_icontains', 'abc', 'xyz', 'string.contains'],
		['_icontains', null, 'xyz', 'any.only'],
		['_starts_with', 'abc', 'xyz', 'string.pattern.name'],
		['_nstarts_with', 'abc', 'abcd', 'string.pattern.invert.name'],
		['_ends_with', 'abc', 'xyz', 'string.pattern.name'],
		['_ends_with', 'abc', 42, 'string.base'],
		['_nends_with', 'abc', 'dabc', 'string.pattern.invert.name'],
		['_istarts_with', 'abc', 'xyz', 'string.pattern.name'],
		['_nistarts_with', 'abc', 'ABCd', 'string.pattern.invert.name'],
		['_iends_with', 'abc', 'xyz', 'string.pattern.name'],
		['_niends_with', 'abc', 'dABC', 'string.pattern.invert.name'],
	])('reports a failed %s rule with operand %j against %j as %s', (operator, operand, value, type) => {
		const filter = { field: { [operator]: operand } } as Filter;

		expect.assertions(1);

		try {
			config.handler({ filter }, { data: { field: value } } as any);
		} catch (err: any) {
			expect(err).toStrictEqual([{ path: ['field'], type }]);
		}
	});
});
