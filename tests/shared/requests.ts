import request, { type Response } from 'supertest';
import { jsonToGraphQLQuery } from 'json-to-graphql-query';

export function processGraphQLJson(jsonQuery: any) {
	return jsonToGraphQLQuery(jsonQuery);
}

export async function requestGraphQL(
	host: string,
	isSystemCollection: boolean,
	token: string | null,
	jsonQuery: any,
	options?: { variables?: any; cookies?: string[] },
	transport: typeof request = request
): Promise<Response> {
	const req = transport(host)
		.post(isSystemCollection ? '/graphql/system' : '/graphql')
		.send({ query: processGraphQLJson(jsonQuery), variables: options?.variables });

	if (token) req.set('Authorization', `Bearer ${token}`);
	if (options?.cookies) req.set('Cookie', options.cookies);
	return await req;
}

export function requestCreateItem(
	host: string,
	token: string,
	options: { collection: string; item: any },
	transport: typeof request = request
) {
	return transport(host)
		.post(`/items/${options.collection}`)
		.set('Authorization', `Bearer ${token}`)
		.send(options.item);
}
