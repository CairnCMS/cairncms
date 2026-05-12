import type { AxiosInstance } from 'axios';
import { ValidatingHttpAgent, ValidatingHttpsAgent } from './agent-with-ip-validation.js';

export const _cache: { axiosInstance: AxiosInstance | null } = {
	axiosInstance: null,
};

export async function getAxios() {
	if (!_cache.axiosInstance) {
		const axios = (await import('axios')).default;

		_cache.axiosInstance = axios.create({
			httpAgent: new ValidatingHttpAgent(),
			httpsAgent: new ValidatingHttpsAgent(),
		});
	}

	return _cache.axiosInstance;
}
