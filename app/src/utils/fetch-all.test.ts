import api from '@/api';
import { useServerStore } from '@/stores/server';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest';
import { fetchAll } from './fetch-all';

function setQueryLimit(queryLimit: { default: number; max: number } | undefined) {
	useServerStore().info.queryLimit = queryLimit;
}

let apiGetSpy: MockInstance;

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
	apiGetSpy = vi.spyOn(api, 'get');
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('fetchAll', () => {
	test('makes a single unlimited request when no maximum is configured', async () => {
		setQueryLimit(undefined);
		apiGetSpy.mockResolvedValue({ data: { data: [1, 2, 3] } });

		const result = await fetchAll('/items/articles');

		expect(apiGetSpy).toHaveBeenCalledTimes(1);
		expect(apiGetSpy).toHaveBeenCalledWith('/items/articles', { params: { limit: -1 } });
		expect(result).toEqual([1, 2, 3]);
	});

	test('makes a single unlimited request when the maximum is -1', async () => {
		setQueryLimit({ default: -1, max: -1 });
		apiGetSpy.mockResolvedValue({ data: { data: [1, 2] } });

		const result = await fetchAll('/items/articles');

		expect(apiGetSpy).toHaveBeenCalledTimes(1);
		expect(apiGetSpy).toHaveBeenCalledWith('/items/articles', { params: { limit: -1 } });
		expect(result).toEqual([1, 2]);
	});

	test('applies a finite limit even when no maximum is configured', async () => {
		setQueryLimit(undefined);
		apiGetSpy.mockResolvedValue({ data: { data: [1, 2, 3] } });

		const result = await fetchAll('/items/articles', {}, 3);

		expect(apiGetSpy).toHaveBeenCalledTimes(1);
		expect(apiGetSpy).toHaveBeenCalledWith('/items/articles', { params: { limit: 3 } });
		expect(result).toEqual([1, 2, 3]);
	});

	test('preserves caller params and does not mutate the config in the unlimited branch', async () => {
		setQueryLimit(undefined);
		apiGetSpy.mockResolvedValue({ data: { data: [] } });
		const config = { params: { fields: ['id'], filter: { status: { _eq: 'published' } } } };

		await fetchAll('/items/articles', config);

		expect(apiGetSpy).toHaveBeenCalledWith('/items/articles', {
			params: { fields: ['id'], filter: { status: { _eq: 'published' } }, limit: -1 },
		});

		expect(config).toEqual({ params: { fields: ['id'], filter: { status: { _eq: 'published' } } } });
	});

	test('paginates by the configured maximum, preserving caller params on every page', async () => {
		setQueryLimit({ default: 2, max: 2 });
		const config = { params: { fields: ['id'], filter: { status: { _eq: 'published' } }, sort: ['id'] } };

		apiGetSpy
			.mockResolvedValueOnce({ data: { data: [1, 2] } })
			.mockResolvedValueOnce({ data: { data: [3, 4] } })
			.mockResolvedValueOnce({ data: { data: [] } });

		const result = await fetchAll('/items/articles', config);

		const paramsForPage = (page: number) => ({
			params: { fields: ['id'], filter: { status: { _eq: 'published' } }, sort: ['id'], page, limit: 2 },
		});

		expect(result).toEqual([1, 2, 3, 4]);
		expect(apiGetSpy).toHaveBeenCalledTimes(3);
		expect(apiGetSpy).toHaveBeenNthCalledWith(1, '/items/articles', paramsForPage(1));
		expect(apiGetSpy).toHaveBeenNthCalledWith(2, '/items/articles', paramsForPage(2));
		expect(apiGetSpy).toHaveBeenNthCalledWith(3, '/items/articles', paramsForPage(3));
		expect(config).toEqual({ params: { fields: ['id'], filter: { status: { _eq: 'published' } }, sort: ['id'] } });
	});

	test('slices to a finite limit and stops fetching once it is reached', async () => {
		setQueryLimit({ default: 2, max: 2 });
		apiGetSpy.mockResolvedValueOnce({ data: { data: [1, 2] } }).mockResolvedValueOnce({ data: { data: [3, 4] } });

		const result = await fetchAll('/items/articles', {}, 3);

		expect(result).toEqual([1, 2, 3]);
		expect(apiGetSpy).toHaveBeenCalledTimes(2);
	});
});
