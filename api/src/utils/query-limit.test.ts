import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveQueryLimitConfig, validateQueryLimitConfig } from './query-limit.js';

let factoryEnv: Record<string, any> = {};

vi.mock('../env.js', () => ({
	default: new Proxy({}, { get: (_target, prop) => factoryEnv[prop as string] }),
}));

afterEach(() => {
	factoryEnv = {};
});

describe('resolveQueryLimitConfig', () => {
	test.each([
		['unset', {}, 100, -1, 100],
		['finite default < max', { QUERY_LIMIT_DEFAULT: 5, QUERY_LIMIT_MAX: 10 }, 5, 10, 5],
		['finite default > max', { QUERY_LIMIT_DEFAULT: 50, QUERY_LIMIT_MAX: 10 }, 50, 10, 10],
		['finite default, unset max', { QUERY_LIMIT_DEFAULT: 25 }, 25, -1, 25],
		['default -1, finite max', { QUERY_LIMIT_DEFAULT: -1, QUERY_LIMIT_MAX: 10 }, -1, 10, 10],
		['default -1, unset max', { QUERY_LIMIT_DEFAULT: -1 }, -1, -1, -1],
		['default -1, -1 max', { QUERY_LIMIT_DEFAULT: -1, QUERY_LIMIT_MAX: -1 }, -1, -1, -1],
		['finite default, -1 max', { QUERY_LIMIT_DEFAULT: 25, QUERY_LIMIT_MAX: -1 }, 25, -1, 25],
		['zero default, unset max', { QUERY_LIMIT_DEFAULT: 0 }, 0, -1, 0],
		['zero default, finite max', { QUERY_LIMIT_DEFAULT: 0, QUERY_LIMIT_MAX: 10 }, 0, 10, 0],
		['string values', { QUERY_LIMIT_DEFAULT: '5', QUERY_LIMIT_MAX: '10' }, 5, 10, 5],
		['string -1 sentinel', { QUERY_LIMIT_MAX: '-1' }, 100, -1, 100],
		['max at the GraphQL int ceiling', { QUERY_LIMIT_MAX: 2_147_483_647 }, 100, 2_147_483_647, 100],
		['default at the GraphQL int ceiling', { QUERY_LIMIT_DEFAULT: 2_147_483_647 }, 2_147_483_647, -1, 2_147_483_647],
	])('normalizes %s', (_label, source, expectedDefault, expectedMax, expectedEffectiveDefault) => {
		const result = resolveQueryLimitConfig(source as Record<string, any>);

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.config).toEqual({
				default: expectedDefault,
				max: expectedMax,
				effectiveDefault: expectedEffectiveDefault,
			});
		}
	});

	test.each([
		['malformed string max', { QUERY_LIMIT_MAX: 'abc' }],
		['fractional max', { QUERY_LIMIT_MAX: 1.5 }],
		['fractional default', { QUERY_LIMIT_DEFAULT: 2.5 }],
		['unsafe integer max', { QUERY_LIMIT_MAX: Number.MAX_SAFE_INTEGER + 1 }],
		['zero max', { QUERY_LIMIT_MAX: 0 }],
		['max above the GraphQL int ceiling', { QUERY_LIMIT_MAX: 2_147_483_648 }],
		['default above the GraphQL int ceiling', { QUERY_LIMIT_DEFAULT: 2_147_483_648 }],
		['negative non-sentinel max', { QUERY_LIMIT_MAX: -2 }],
		['negative non-sentinel default', { QUERY_LIMIT_DEFAULT: -3 }],
	])('rejects %s', (_label, source) => {
		expect(resolveQueryLimitConfig(source as Record<string, any>).ok).toBe(false);
	});
});

describe('validateQueryLimitConfig (startup)', () => {
	test('passes a valid config', () => {
		factoryEnv = { QUERY_LIMIT_DEFAULT: 100, QUERY_LIMIT_MAX: 10 };
		expect(() => validateQueryLimitConfig()).not.toThrow();
	});

	test('throws on a malformed config', () => {
		factoryEnv = { QUERY_LIMIT_MAX: 'abc' };
		expect(() => validateQueryLimitConfig()).toThrow(/QUERY_LIMIT_MAX/);
	});
});
