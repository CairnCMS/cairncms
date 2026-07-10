import type { Request } from 'express';
import type { SpyInstance } from 'vitest';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { getCacheKey } from './get-cache-key.js';
import * as getGraphqlQueryUtil from './get-graphql-query-and-variables.js';

vi.mock('./package.js', () => ({ version: '1.2.3' }));

const baseUrl = 'http://localhost';
const restUrl = `${baseUrl}/items/example`;
const graphQlUrl = `${baseUrl}/graphql`;
const accountability = { user: '00000000-0000-0000-0000-000000000000' };
const method = 'GET';

const requests = [
	{
		name: 'as unauthenticated request',
		params: { method, originalUrl: restUrl },
		key: 'da8873209dfcc5473fe3a936336f509f60e48549',
	},
	{
		name: 'as authenticated request',
		params: { method, originalUrl: restUrl, accountability },
		key: 'ef231c52ee2621b894a05a1661bdda0f5b95ad45',
	},
	{
		name: 'a request with a fields query',
		params: { method, originalUrl: restUrl, sanitizedQuery: { fields: ['id', 'name'] } },
		key: 'a45fd98e95672c52fdbde57ceb14ebadfae4dff7',
	},
	{
		name: 'a request with a filter query',
		params: { method, originalUrl: restUrl, sanitizedQuery: { filter: { name: { _eq: 'test' } } } },
		key: '28020b3017e0952bea96828abb0d11461b55f833',
	},
	{
		name: 'a GraphQL GET query request',
		params: { method, originalUrl: graphQlUrl, query: { query: 'query { test { id } }' } },
		key: '66cfc24341701a732000ff3dc9d8940bfeac2aa6',
	},
	{
		name: 'a GraphQL POST query request',
		params: { method: 'POST', originalUrl: graphQlUrl, body: { query: 'query { test { name } }' } },
		key: 'cfbbe707330099cc1626b58cb90aa5c76cbd2e4b',
	},
	{
		name: 'an authenticated GraphQL GET query request',
		params: { method, originalUrl: graphQlUrl, accountability, query: { query: 'query { test { id } }' } },
		key: 'ac48e12f4780029e20749c8405272d84d0969c1f',
	},
	{
		name: 'an authenticated GraphQL POST query request',
		params: { method: 'POST', originalUrl: graphQlUrl, accountability, body: { query: 'query { test { name } }' } },
		key: '8d466caca70f084073face70a5a82978234697be',
	},
];

const cases = requests.map(({ name, params, key }) => [name, params, key]);

afterEach(() => {
	vi.clearAllMocks();
});

describe('get cache key', () => {
	describe('isGraphQl', () => {
		let getGraphqlQuerySpy: SpyInstance;

		beforeAll(() => {
			getGraphqlQuerySpy = vi.spyOn(getGraphqlQueryUtil, 'getGraphqlQueryAndVariables');
		});

		test.each(['/items/test', '/items/graphql', '/collections/test', '/collections/graphql'])(
			'path "%s" should not be interpreted as a graphql query',
			(path) => {
				getCacheKey({ originalUrl: `${baseUrl}${path}` } as Request);
				expect(getGraphqlQuerySpy).not.toHaveBeenCalled();
			}
		);

		test.each(['/graphql', '/graphql/system'])('path "%s" should be interpreted as a graphql query', (path) => {
			getCacheKey({ originalUrl: `${baseUrl}${path}` } as Request);
			expect(getGraphqlQuerySpy).toHaveBeenCalledOnce();
		});
	});

	test.each(cases)('should create a cache key for %s', (_, params, key) => {
		expect(getCacheKey(params as unknown as Request)).toEqual(key);
	});

	test('should create a unique key for each request', () => {
		const keys = cases.map(([, params]) => getCacheKey(params as unknown as Request));
		const hasDuplicate = keys.some((key) => keys.indexOf(key) !== keys.lastIndexOf(key));

		expect(hasDuplicate).toBeFalsy();
	});

	test('should create a unique key for GraphQL requests with different variables', () => {
		const query = 'query Test ($name: String) { test (filter: { name: { _eq: $name } }) { id } }';
		const operationName = 'test';
		const variables1 = JSON.stringify({ name: 'test 1' });
		const variables2 = JSON.stringify({ name: 'test 2' });
		const req1: any = { method, originalUrl: graphQlUrl, query: { query, operationName, variables: variables1 } };
		const req2: any = { method, originalUrl: graphQlUrl, query: { query, operationName, variables: variables2 } };
		const postReq1: any = { method: 'POST', originalUrl: req1.originalUrl, body: req1.query };
		const postReq2: any = { method: 'POST', originalUrl: req2.originalUrl, body: req2.query };

		expect(getCacheKey(req1)).not.toEqual(getCacheKey(req2));
		expect(getCacheKey(postReq1)).not.toEqual(getCacheKey(postReq2));
		expect(getCacheKey(req1)).toEqual(getCacheKey(postReq1));
		expect(getCacheKey(req2)).toEqual(getCacheKey(postReq2));
	});
});

describe('authorization-context segmentation', () => {
	const namedUser = '00000000-0000-0000-0000-000000000000';
	const scope = { item: '1', collection: 'articles' };

	const req = (acc: Record<string, any> | undefined): Request =>
		({ method, originalUrl: restUrl, accountability: acc } as unknown as Request);

	test('a share and an anonymous request do not share a key', () => {
		const share = req({ user: null, role: 'role-a', share: 'share-a', share_scope: scope });
		const anonymous = req(undefined);

		expect(getCacheKey(share)).not.toEqual(getCacheKey(anonymous));
	});

	test('two shares with the same role and scope but different share ids do not share a key', () => {
		const shareA = req({ user: null, role: 'role-a', share: 'share-a', share_scope: scope });
		const shareB = req({ user: null, role: 'role-a', share: 'share-b', share_scope: scope });

		expect(getCacheKey(shareA)).not.toEqual(getCacheKey(shareB));
	});

	test('two shares with different scope do not share a key', () => {
		const shareX = req({
			user: null,
			role: 'role-a',
			share: 'share-a',
			share_scope: { item: '1', collection: 'articles' },
		});

		const shareY = req({
			user: null,
			role: 'role-a',
			share: 'share-a',
			share_scope: { item: '2', collection: 'articles' },
		});

		expect(getCacheKey(shareX)).not.toEqual(getCacheKey(shareY));
	});

	test('requests differing only by role do not share a key', () => {
		expect(getCacheKey(req({ user: null, role: 'role-a' }))).not.toEqual(
			getCacheKey(req({ user: null, role: 'role-b' }))
		);
	});

	test('requests differing only by app access do not share a key', () => {
		expect(getCacheKey(req({ user: namedUser, app: true }))).not.toEqual(
			getCacheKey(req({ user: namedUser, app: false }))
		);
	});

	test('requests differing only by admin do not share a key', () => {
		expect(getCacheKey(req({ user: namedUser, admin: true }))).not.toEqual(
			getCacheKey(req({ user: namedUser, admin: false }))
		);
	});

	test('the same user and accountability produce the same key (cache hit preserved)', () => {
		const acc = { user: namedUser, role: 'role-a', app: true, admin: false };

		expect(getCacheKey(req({ ...acc }))).toEqual(getCacheKey(req({ ...acc })));
	});
});
