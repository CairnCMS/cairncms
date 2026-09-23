import { BaseException } from '@cairncms/exceptions';
import { describe, expect, it } from 'vitest';
import { configFailureExitCode } from './exit-code.js';

function typed(status: number): BaseException {
	return new BaseException('failure', status, 'SOME_CODE');
}

describe('configFailureExitCode', () => {
	it('maps a single 400-class exception to 2', () => {
		expect(configFailureExitCode(typed(400))).toBe(2);
	});

	it('maps a single 500-class exception to 3', () => {
		expect(configFailureExitCode(typed(500))).toBe(3);
	});

	it('maps a non-typed error to 3', () => {
		expect(configFailureExitCode(new Error('boom'))).toBe(3);
	});

	it('maps an array of 400-class exceptions to 2', () => {
		expect(configFailureExitCode([typed(400), typed(409)])).toBe(2);
	});

	it('maps a mixed 400-and-500 array to 3', () => {
		expect(configFailureExitCode([typed(400), typed(500)])).toBe(3);
	});

	it('maps an array mixing a typed and a non-typed member to 3', () => {
		expect(configFailureExitCode([typed(400), new Error('boom')])).toBe(3);
	});

	it('maps an empty array to 3', () => {
		expect(configFailureExitCode([])).toBe(3);
	});
});
