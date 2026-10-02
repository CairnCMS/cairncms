import type supertest from 'supertest';
import { requestGraphQL as graphql, requestCreateItem } from '@cairncms/test-utils';
import type { Api } from './environment';
import { createRequest, assertSetupResponse as checkSetupResponse } from './request-agent.mjs';

const request = ((host: string) => createRequest(host)) as unknown as typeof supertest;

export const setupRequest = ((host: string) => createRequest(host, { setup: true })) as unknown as typeof supertest;

export default request;

export const assertSetupResponse = (response: supertest.Response): supertest.Response => checkSetupResponse(response);

export const requestGraphQL: typeof graphql = (host, system, token, query, options) =>
	graphql(host, system, token, query, options, request);

export const setupGraphQL: typeof graphql = (host, system, token, query, options) =>
	graphql(host, system, token, query, options, setupRequest);

export async function CreateItem(api: Api, options: { collection: string; item: any }) {
	const response = await requestCreateItem(api.url, api.adminToken, options, setupRequest).expect(200);
	if (response.body.data === undefined) throw new Error(`Item fixture returned no data for ${options.collection}`);
	return response.body.data;
}
