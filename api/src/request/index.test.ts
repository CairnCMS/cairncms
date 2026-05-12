import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { _cache, getAxios } from './index.js';

vi.mock('axios');

let mockAxiosInstance: AxiosInstance;

beforeEach(() => {
	mockAxiosInstance = {} as unknown as AxiosInstance;
	vi.mocked(axios.create).mockReturnValue(mockAxiosInstance);
});

afterEach(() => {
	vi.resetAllMocks();
	_cache.axiosInstance = null;
});

test('Creates and returns new axios instance if cache is empty', async () => {
	const instance = await getAxios();
	expect(axios.create).toHaveBeenCalled();
	expect(instance).toBe(mockAxiosInstance);
});

test('Passes validating http and https agents to axios.create', async () => {
	await getAxios();
	const createOpts = vi.mocked(axios.create).mock.calls[0]?.[0];
	expect(createOpts?.httpAgent).toBeDefined();
	expect(createOpts?.httpsAgent).toBeDefined();
});
