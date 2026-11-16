import { BaseException, ForbiddenException } from '@cairncms/exceptions';
import type { ApiExtensionContext } from '@cairncms/types';
import { describe, expect, expectTypeOf, it } from 'vitest';
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

describe('the typed extension exceptions context', () => {
	const exceptions: ApiExtensionContext['exceptions'] = createExtensionExceptions();

	it('accepts the documented calls', () => {
		expect(new exceptions.InvalidPayloadException('payload is required').code).toBe('INVALID_PAYLOAD');
		expect(new exceptions.ForbiddenException().status).toBe(403);
		expect(new exceptions.RouteNotFoundException('/nowhere').status).toBe(404);

		const methodNotAllowed = new exceptions.MethodNotAllowedException('Use POST.', { allow: ['POST'] });

		const unavailable = new exceptions.ServiceUnavailableException('The upstream service is unavailable.', {
			service: 'weather',
		});

		expect(methodNotAllowed.extensions.allow).toEqual(['POST']);
		expect(unavailable.extensions.service).toBe('weather');
	});

	it('types the details of a custom subclass', () => {
		class QuotaExceededException extends exceptions.BaseException<{ limit: number }> {
			constructor(limit: number) {
				super('Quota exceeded.', 429, 'QUOTA_EXCEEDED', { limit });
			}
		}

		const error = new QuotaExceededException(5);

		expectTypeOf(error.extensions.limit).toEqualTypeOf<number>();
		expect(error).toBeInstanceOf(exceptions.BaseException);
	});

	it('narrows a common class with instanceof', () => {
		const error: unknown = new exceptions.ForbiddenException();

		if (!(error instanceof exceptions.ForbiddenException)) throw error;

		expectTypeOf(error).toEqualTypeOf<ForbiddenException>();
	});

	it('keeps an API-local class constructible, extendable, and recognizable', () => {
		class StrictConfigInvalidException extends exceptions.ConfigInvalidException {}

		const error: unknown = new StrictConfigInvalidException('The configuration is invalid.');

		if (!(error instanceof exceptions.ConfigInvalidException)) throw error;

		expectTypeOf(error).toMatchTypeOf<BaseException>();
		expect(error.code).toBe('CONFIG_INVALID');
	});

	it('has no member the context does not provide', () => {
		expectTypeOf(exceptions).not.toHaveProperty('NotAClassException');
		expectTypeOf(exceptions).not.toHaveProperty('CONFIG_POST_COMMIT_PHASES');
	});

	it('rejects calls the common classes do not support', () => {
		// @ts-expect-error a forbidden error takes no message
		new exceptions.ForbiddenException('x');

		// @ts-expect-error the message must be a string
		new exceptions.ServiceUnavailableException(1);

		// @ts-expect-error a method-not-allowed error needs the allowed methods
		new exceptions.MethodNotAllowedException('m');
	});
});
