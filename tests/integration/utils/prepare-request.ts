import type { Api } from '../fixtures/environment';
import request from '../fixtures/request';

export type AllowedRequestMethods = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'search';

export type RequestOptions = {
	path: string;
	method: AllowedRequestMethods;
	token: string;
	body?: any;
};

export const PrepareRequest = (api: Api, requestOptions: RequestOptions) => {
	const req = request(api.url)[requestOptions.method](requestOptions.path);

	if (requestOptions.token) {
		req.set('Authorization', `Bearer ${requestOptions.token}`);
	}

	if (requestOptions.body) {
		req.send(requestOptions.body);
	}

	return req;
};
