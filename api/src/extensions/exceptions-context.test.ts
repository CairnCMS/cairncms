import { BaseException, ForbiddenException } from '@cairncms/exceptions';
import { describe, expect, it } from 'vitest';
import { exceptionsContextKeys } from '../__utils__/exceptions-context-fixtures.js';
import { createExtensionExceptions } from './exceptions-context.js';

describe('createExtensionExceptions', () => {
	it('returns a new object on each call, so one extension changing its copy affects no other', () => {
		const first: Record<string, unknown> = createExtensionExceptions();

		first['ForbiddenException'] = undefined;

		expect(createExtensionExceptions()).not.toBe(first);
		expect(createExtensionExceptions().ForbiddenException).toBe(ForbiddenException);
	});

	it('contains exactly the exception classes and nothing else', () => {
		const context: Record<string, unknown> = createExtensionExceptions();

		const notClasses = Object.keys(context).filter((key) => {
			const value = context[key];
			return !(value === BaseException || (typeof value === 'function' && value.prototype instanceof BaseException));
		});

		expect(Object.keys(context).sort()).toEqual(exceptionsContextKeys);
		expect(notClasses).toEqual([]);
	});
});
