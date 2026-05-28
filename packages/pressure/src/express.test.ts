import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { handlePressure } from './express.js';
import { PressureMonitor } from './monitor.js';

vi.mock('./monitor.js');

let req: Request;
let res: Response;
let next: NextFunction;
let header: ReturnType<typeof vi.fn>;
let overloadedGetter: ReturnType<typeof vi.fn>;

beforeEach(() => {
	req = {} as Request;
	header = vi.fn();
	res = { header } as unknown as Response;
	next = vi.fn();

	overloadedGetter = vi.fn();

	vi.mocked(PressureMonitor).mockImplementation(
		() =>
			({
				get overloaded() {
					return overloadedGetter();
				},
			} as unknown as PressureMonitor)
	);
});

afterEach(() => {
	vi.resetAllMocks();
});

describe('handlePressure', () => {
	test('Calls next without arguments when the monitor is not overloaded', () => {
		overloadedGetter.mockReturnValue(false);

		const middleware = handlePressure({ maxEventLoopUtilization: 0.9 });
		middleware(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		expect(next).toHaveBeenCalledWith();
		expect(header).not.toHaveBeenCalled();
	});

	test('Calls next with the default error when the monitor is overloaded and no custom error is provided', () => {
		overloadedGetter.mockReturnValue(true);

		const middleware = handlePressure({ maxEventLoopUtilization: 0.9 });
		middleware(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		const passed = vi.mocked(next).mock.calls[0]![0] as Error;
		expect(passed).toBeInstanceOf(Error);
		expect(passed.message).toBe('Pressure limit exceeded');
	});

	test('Calls next with the custom error when one is provided and the monitor is overloaded', () => {
		overloadedGetter.mockReturnValue(true);

		const customError = new Error('Under pressure');
		const middleware = handlePressure({ maxEventLoopUtilization: 0.9, error: customError });
		middleware(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		expect(next).toHaveBeenCalledWith(customError);
	});

	test('Sets the Retry-After header when retryAfter is configured and the monitor is overloaded', () => {
		overloadedGetter.mockReturnValue(true);

		const middleware = handlePressure({ maxEventLoopUtilization: 0.9, retryAfter: '30' });
		middleware(req, res, next);

		expect(header).toHaveBeenCalledOnce();
		expect(header).toHaveBeenCalledWith('Retry-After', '30');
	});
});
