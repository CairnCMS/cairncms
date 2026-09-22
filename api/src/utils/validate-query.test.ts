import type { Query } from '@cairncms/types';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import env from '../env.js';

const loadValidateQueryModule = async (mockedEnv?: Partial<typeof env>) => {
	vi.doMock('../env', async () => {
		return {
			default: {
				...env,
				...mockedEnv,
			},
		};
	});

	return await import('./validate-query.js');
};

const getValidateQuery = async (mockedEnv?: Partial<typeof env>) => {
	return (await loadValidateQueryModule(mockedEnv)).validateQuery;
};

beforeEach(() => {
	vi.resetModules();
});

describe('max limit', () => {
	describe('max limit of 100', async () => {
		const validateQuery = await getValidateQuery({ QUERY_LIMIT_MAX: 100 });

		test.each([-1, 1, 25])('should accept number %i', (limit) => {
			expect(() => validateQuery({ limit })).not.toThrowError('limit');
		});

		test('should error with 101', () => {
			expect(() => validateQuery({ limit: 101 })).toThrowError('limit');
		});
	});

	test('should accept 101 when no limit defined', async () => {
		const validateQuery = await getValidateQuery();

		expect(() => validateQuery({ limit: 101 })).not.toThrowError('limit');
	});

	test('should accept 101 when unlimited', async () => {
		const validateQuery = await getValidateQuery({ QUERY_LIMIT_MAX: -1 });

		expect(() => validateQuery({ limit: 101 })).not.toThrowError('limit');
	});
});

describe('deep max limit', () => {
	test('rejects a deep _limit above the maximum', async () => {
		const validateQuery = await getValidateQuery({ QUERY_LIMIT_MAX: 10 });

		expect(() => validateQuery({ deep: { translations: { _limit: 11 } } } satisfies Query)).toThrowError('limit');
	});

	test('rejects a nested deep _limit above the maximum', async () => {
		const validateQuery = await getValidateQuery({ QUERY_LIMIT_MAX: 10 });

		expect(() => validateQuery({ deep: { translations: { languages: { _limit: 50 } } } } satisfies Query)).toThrowError(
			'limit'
		);
	});

	test.each([-2, 1.5, NaN])('rejects an invalid deep _limit of %s', async (limit) => {
		const validateQuery = await getValidateQuery({ QUERY_LIMIT_MAX: 10 });

		expect(() => validateQuery({ deep: { translations: { _limit: limit } } } satisfies Query)).toThrowError('limit');
	});

	test('rejects an invalid deep _limit even when no maximum is configured', async () => {
		const validateQuery = await getValidateQuery();

		expect(() => validateQuery({ deep: { translations: { _limit: -2 } } } satisfies Query)).toThrowError('limit');
	});

	test('accepts a deep _limit at the maximum', async () => {
		const validateQuery = await getValidateQuery({ QUERY_LIMIT_MAX: 10 });

		expect(() => validateQuery({ deep: { translations: { _limit: 10 } } } satisfies Query)).not.toThrowError();
	});

	test('accepts a deep _limit of -1', async () => {
		const validateQuery = await getValidateQuery({ QUERY_LIMIT_MAX: 10 });

		expect(() => validateQuery({ deep: { translations: { _limit: -1 } } } satisfies Query)).not.toThrowError();
	});

	test('accepts a valid deep _limit when no maximum is configured', async () => {
		const validateQuery = await getValidateQuery();

		expect(() => validateQuery({ deep: { translations: { _limit: 999 } } } satisfies Query)).not.toThrowError();
	});
});

describe('validateDeepQueryLimits', () => {
	const getValidateDeepQueryLimits = async (mockedEnv?: Partial<typeof env>) => {
		return (await loadValidateQueryModule(mockedEnv)).validateDeepQueryLimits;
	};

	test('rejects a deep _limit above the configured maximum', async () => {
		const validateDeepQueryLimits = await getValidateDeepQueryLimits({ QUERY_LIMIT_MAX: 10 });

		expect(() => validateDeepQueryLimits({ children: { _limit: 1000 } })).toThrowError('limit');
	});

	test('rejects a nested deep _limit above the configured maximum', async () => {
		const validateDeepQueryLimits = await getValidateDeepQueryLimits({ QUERY_LIMIT_MAX: 10 });

		expect(() => validateDeepQueryLimits({ children: { grandchildren: { _limit: 1000 } } })).toThrowError('limit');
	});

	test('accepts a deep _limit at the configured maximum', async () => {
		const validateDeepQueryLimits = await getValidateDeepQueryLimits({ QUERY_LIMIT_MAX: 10 });

		expect(() => validateDeepQueryLimits({ children: { _limit: 10 } })).not.toThrowError();
	});

	test('accepts a deep _limit above the default cap when no maximum is configured', async () => {
		const validateDeepQueryLimits = await getValidateDeepQueryLimits();

		expect(() => validateDeepQueryLimits({ children: { _limit: 1000 } })).not.toThrowError();
	});
});

describe('export', async () => {
	const validateQuery = await getValidateQuery();

	test.each(['csv', 'json', 'xml', 'yaml'])('should accept format %i', (format) => {
		expect(() => validateQuery({ export: format } as any)).not.toThrowError();
	});

	test('should error with invalid-format', () => {
		expect(() => validateQuery({ export: 'invalid-format' } as any)).toThrowError('"export" must be one of');
	});
});

describe('boolean and geometry flag validation', async () => {
	const validateQuery = await getValidateQuery();

	test.each(['_null', '_nnull', '_empty', '_nempty'])('accepts an empty-string %s flag', (operator) => {
		expect(() => validateQuery({ filter: { title: { [operator]: '' } } } as any)).not.toThrowError();
	});

	test.each([true, false, null])('accepts the boolean flag value %s', (value) => {
		expect(() => validateQuery({ filter: { title: { _null: value } } } as any)).not.toThrowError();
	});

	test.each(['wrong', undefined])('rejects the non-boolean flag value %s', (value) => {
		expect(() => validateQuery({ filter: { title: { _null: value } } } as any)).toThrowError('has to be a boolean');
	});

	test('still rejects an empty-string geometry flag', () => {
		expect(() => validateQuery({ filter: { location: { _intersects: '' } } } as any)).toThrowError('valid GeoJSON');
	});
});
