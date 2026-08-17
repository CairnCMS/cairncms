import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getEnv } from '../env.js';
import { InvalidPayloadException } from '../exceptions/index.js';
import { parseGraphQL } from './graphql.js';

function requestFor(query: string) {
	return { method: 'POST', body: { query }, get: vi.fn() } as unknown as Request;
}

function responseStub() {
	return { locals: {} as Record<string, unknown> } as unknown as Response;
}

async function run(query: string) {
	const req = requestFor(query);
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
});
