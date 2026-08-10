import { useServerStore } from '@/stores/server';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { usePageSize } from './use-page-size';

const AVAILABLE_SIZES = [10, 25, 50, 100, 250, 500, 1000, 10000];

function setQueryLimit(queryLimit: { default: number; max: number } | undefined) {
	useServerStore().info.queryLimit = queryLimit;
}

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
});

describe('usePageSize', () => {
	test('returns all sizes when there is no query limit', () => {
		setQueryLimit(undefined);

		const { sizes, selected } = usePageSize<number>(AVAILABLE_SIZES, (x) => x, 25);

		expect(sizes.value).toStrictEqual(AVAILABLE_SIZES);
		expect(selected).toBe(25);
	});

	test('maps sizes through the callback', () => {
		setQueryLimit(undefined);

		const { sizes, selected } = usePageSize<string>(AVAILABLE_SIZES, (x) => String(x), 25);

		expect(sizes.value).toStrictEqual(['10', '25', '50', '100', '250', '500', '1000', '10000']);
		expect(selected).toBe(25);
	});

	test('returns all sizes when the maximum is unlimited', () => {
		setQueryLimit({ default: -1, max: -1 });

		const { sizes, selected } = usePageSize<number>(AVAILABLE_SIZES, (x) => x, 25);

		expect(sizes.value).toStrictEqual(AVAILABLE_SIZES);
		expect(selected).toBe(25);
	});

	test('filters sizes to the maximum', () => {
		setQueryLimit({ default: 100, max: 100 });

		const { sizes, selected } = usePageSize<number>(AVAILABLE_SIZES, (x) => x, 25);

		expect(sizes.value).toStrictEqual([10, 25, 50, 100]);
		expect(selected).toBe(25);
	});

	test('excludes sizes above the maximum', () => {
		setQueryLimit({ default: 100, max: 99 });

		const { sizes, selected } = usePageSize<number>(AVAILABLE_SIZES, (x) => x, 25);

		expect(sizes.value).toStrictEqual([10, 25, 50]);
		expect(selected).toBe(25);
	});

	test('falls back to the maximum and clamps the selection when no size fits', () => {
		setQueryLimit({ default: 100, max: 9 });

		const { sizes, selected } = usePageSize<number>(AVAILABLE_SIZES, (x) => x, 25);

		expect(sizes.value).toStrictEqual([9]);
		expect(selected).toBe(9);
	});
});
