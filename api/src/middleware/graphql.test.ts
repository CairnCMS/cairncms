import { InvalidPayloadException } from '@cairncms/exceptions';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getEnv } from '../env.js';
import { parseGraphQLQuery } from '../services/graphql/query-gate.js';
import { parseGraphQL } from './graphql.js';

vi.mock('../services/graphql/query-gate.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../services/graphql/query-gate.js')>();
	return { ...actual, parseGraphQLQuery: vi.fn(actual.parseGraphQLQuery) };
});

function requestFor(query: unknown, method = 'POST') {
	return method === 'GET'
		? ({ method, query: { query }, get: vi.fn() } as unknown as Request)
		: ({ method, body: { query }, get: vi.fn() } as unknown as Request);
}

function responseStub() {
	return { locals: {} as Record<string, unknown> } as unknown as Response;
}

function rejection(next: NextFunction) {
	return (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as InvalidPayloadException;
}

async function run(query: unknown, method = 'POST') {
	const req = requestFor(query, method);
	const res = responseStub();
	const next = vi.fn() as unknown as NextFunction;

	await (parseGraphQL as unknown as (q: Request, s: Response, n: NextFunction) => Promise<void>)(req, res, next);

	return { res, next };
}

describe('Middleware / parseGraphQL', () => {
	let originalLimit: unknown;

	beforeAll(() => {
		originalLimit = getEnv()['GRAPHQL_QUERY_TOKEN_LIMIT'];
	});

	afterEach(() => {
		getEnv()['GRAPHQL_QUERY_TOKEN_LIMIT'] = originalLimit;
	});

	it('passes a document within the token limit through to res.locals', async () => {
		getEnv()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 5000;

		const { res, next } = await run('{ users { id } }');

		expect(next).toHaveBeenCalledOnce();
		expect((res.locals as any)['graphqlParams'].document).toBeDefined();
	});

	it('rejects a document over the token limit as an invalid payload', async () => {
		getEnv()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 4;

		const { res, next } = await run('{ users { id name email } }');

		expect(next).toHaveBeenCalledWith(expect.any(InvalidPayloadException));
		expect((res.locals as any)['graphqlParams']).toBeUndefined();
	});

	it('does not echo document content in the rejection', async () => {
		getEnv()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 4;

		const { next } = await run('{ secretCollection { secretField } }');

		const error = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Error;
		expect(error.message).not.toContain('secretCollection');
		expect(JSON.stringify(error)).not.toContain('secretField');
	});

	it('sends a syntax error in the formatted shape, without a stack trace', async () => {
		getEnv()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 5000;

		const { next } = await run('{ a');
		const error = rejection(next);

		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(error.message).toBe('GraphQL schema validation error.');

		expect(error.extensions).toEqual({
			graphqlErrors: [{ message: 'Syntax Error: Expected Name, found <EOF>.', locations: [{ line: 1, column: 4 }] }],
		});
	});

	it.each([
		['the number', 42],
		['a boolean', true],
		['an array', []],
		['an object', {}],
	])('rejects %s as a query before parsing it', async (_label, query) => {
		const { next } = await run(query);
		const error = rejection(next);

		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(error.message).toBe('Must provide query string.');
		expect(error.extensions).toEqual({});
	});

	it('rejects a repeated query parameter before parsing it', async () => {
		const { next } = await run(['{ a }', '{ b }'], 'GET');
		const error = rejection(next);

		expect(error.message).toBe('Must provide query string.');
		expect(error.extensions).toEqual({});
	});

	it('rejects a parse failure that is not a GraphQL error without attaching it', async () => {
		vi.mocked(parseGraphQLQuery).mockImplementationOnce(() => {
			throw new RangeError('Maximum call stack size exceeded');
		});

		const { next } = await run('{ a }');
		const error = rejection(next);

		expect(error).toBeInstanceOf(InvalidPayloadException);
		expect(error.message).toBe('GraphQL schema validation error.');
		expect(error.extensions).toEqual({});
	});
});
