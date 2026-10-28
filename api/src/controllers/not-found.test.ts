import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const emitFilter = vi.fn(async () => false);

vi.mock('../database/index.js', () => ({ default: vi.fn(() => ({})) }));
vi.mock('../emitter.js', () => ({ default: { emitFilter } }));

const { default: notFound } = await import('./not-found.js');

async function run(originalUrl: string): Promise<{ error: any; req: Request }> {
	const req = {
		originalUrl,
		path: originalUrl.split('?')[0],
		schema: undefined,
		accountability: null,
	} as unknown as Request;

	const res = {} as Response;
	let error: unknown;

	const next = ((err?: unknown) => {
		error = err;
	}) as NextFunction;

	await notFound(req, res, next);

	return { error, req };
}

describe('not found handler diagnostic', () => {
	beforeEach(() => {
		emitFilter.mockClear().mockResolvedValue(false);
	});

	test('keeps credentials out of the 404 message for a malformed authority', async () => {
		const { error } = await run('//alice:secret@[x/items');

		expect(error.message).not.toContain('secret');
	});

	test('keeps credentials out of the 404 message for an empty authority', async () => {
		const { error } = await run('///alice:secret@[x/items');

		expect(error.message).not.toContain('secret');
	});

	test('reports the pathname for an ordinary target', async () => {
		const { error } = await run('/items/books?x=1');

		expect(error.message).toBe(`Route /items/books doesn't exist.`);
	});

	test('passes the raw request to the not-found filter', async () => {
		const { req } = await run('//alice:secret@[x/items');

		expect(emitFilter).toHaveBeenCalledWith(
			'request.not_found',
			false,
			expect.objectContaining({ request: req }),
			expect.anything()
		);
	});
});
