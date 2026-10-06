import type { Request } from 'express';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InvalidConfigException } from '../exceptions/index.js';
import { boundedBodyParser } from './bounded-body-parser.js';

vi.mock('../logger.js', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function recorder() {
	const limits: number[] = [];
	const handler = vi.fn();

	const build = (limit: number) => {
		limits.push(limit);
		return handler;
	};

	return { build, limits, handler };
}

describe('boundedBodyParser', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('builds the parser with the parsed byte limit for a size string', () => {
		const { build, limits, handler } = recorder();
		expect(boundedBodyParser('1mb', 'application/json', build)).toBe(handler);
		expect(limits).toEqual([1048576]);
	});

	test('accepts a fractional size that bytes resolves to an integer', () => {
		const { build, limits } = recorder();
		boundedBodyParser('1.5mb', 'application/json', build);
		expect(limits).toEqual([1572864]);
	});

	test('accepts a numeric byte count', () => {
		const { build, limits } = recorder();
		boundedBodyParser(2097152, 'application/json', build);
		expect(limits).toEqual([2097152]);
	});

	test.each([undefined, null, ''])('falls back to the 1 MiB default when unset (%s)', (raw) => {
		const { build, limits } = recorder();
		boundedBodyParser(raw, 'application/json', build);
		expect(limits).toEqual([1048576]);
	});

	test.each(['abc', 'notasize', Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'does not build the parser for an invalid value (%s)',
		(raw) => {
			const { build, limits } = recorder();
			const handler = boundedBodyParser(raw as unknown, 'application/json', build);
			expect(limits).toEqual([]);
			expect(typeof handler).toBe('function');
		}
	);

	test('the fallback handler rejects requests whose content type the parser would consume', () => {
		const { build } = recorder();
		const handler = boundedBodyParser('abc', 'application/json', build);
		const next = vi.fn();
		handler({ is: () => 'application/json' } as unknown as Request, {} as never, next);
		expect(next).toHaveBeenCalledOnce();
		expect(next.mock.calls[0]![0]).toBeInstanceOf(InvalidConfigException);
	});

	test('the fallback handler leaves independent requests untouched', () => {
		const { build } = recorder();
		const handler = boundedBodyParser('abc', 'application/json', build);
		const next = vi.fn();
		handler({ is: () => false } as unknown as Request, {} as never, next);
		expect(next).toHaveBeenCalledOnce();
		expect(next.mock.calls[0]![0]).toBeUndefined();
	});

	test('the fallback handler skips a body an earlier parser already consumed', () => {
		const { build } = recorder();
		const handler = boundedBodyParser('abc', 'application/json', build);
		const next = vi.fn();
		handler({ is: () => 'application/json', _body: true } as unknown as Request, {} as never, next);
		expect(next).toHaveBeenCalledOnce();
		expect(next.mock.calls[0]![0]).toBeUndefined();
	});
});
