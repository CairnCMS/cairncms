import { BaseException } from '@cairncms/exceptions';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { RecordNotUniqueException } from './database/record-not-unique.js';
import { MethodNotAllowedException } from './method-not-allowed.js';

describe('BaseException details typing', () => {
	it('keeps free-form details optional, without inferring a type from passed details', () => {
		expectTypeOf(new BaseException('m', 400, 'X').extensions).toEqualTypeOf<Record<string, any>>();
		expectTypeOf(new BaseException('m', 400, 'X', { anything: 1 }).extensions).toEqualTypeOf<Record<string, any>>();
	});

	it('keeps partial details optional, including an explicit undefined', () => {
		const omitted = new BaseException<Partial<{ a: string }>>('m', 400, 'X');
		const forwarded = new BaseException<Partial<{ a: string }>>('m', 400, 'X', undefined);

		expectTypeOf(omitted.extensions).toEqualTypeOf<Partial<{ a: string }>>();
		expectTypeOf(forwarded.extensions.a).toEqualTypeOf<string | undefined>();
	});

	it('types the details of a subclass', () => {
		class Quota extends BaseException<{ limit: number }> {
			constructor(limit: number) {
				super('Quota exceeded.', 429, 'QUOTA', { limit });
			}
		}

		expectTypeOf(new Quota(5).extensions.limit).toEqualTypeOf<number>();
	});

	it('requires details for a shape with required fields', () => {
		// @ts-expect-error details with a required field cannot be omitted
		new BaseException<{ limit: number }>('m', 400, 'X');
	});

	it('rejects a primitive details type', () => {
		// @ts-expect-error details must be an object type
		new BaseException<boolean>('m', 400, 'X', false);
	});
});

describe('RecordNotUniqueException details typing', () => {
	it('stores details that may be absent', () => {
		const error: unknown = new RecordNotUniqueException('email');

		if (!(error instanceof RecordNotUniqueException)) throw error;

		expectTypeOf(error.extensions.collection).toEqualTypeOf<string | undefined>();
		expectTypeOf(error.extensions.field).toEqualTypeOf<string | null | undefined>();

		// @ts-expect-error collection is absent when no details were passed
		const collection: string = error.extensions['collection'];

		expect(collection).toBeUndefined();
	});

	it('requires the complete shape when details are passed', () => {
		// @ts-expect-error details without a collection are incomplete
		new RecordNotUniqueException('email', { field: 'email' });
	});
});

describe('MethodNotAllowedException details typing', () => {
	it('types the allowed methods', () => {
		const error: unknown = new MethodNotAllowedException(undefined, { allow: ['GET'] });

		if (!(error instanceof MethodNotAllowedException)) throw error;

		expectTypeOf(error.extensions.allow).toEqualTypeOf<string[]>();

		// @ts-expect-error allow lists method names, not a number
		const allow: number = error.extensions['allow'];

		expect(allow).toEqual(['GET']);
	});

	it('rejects allowed methods that are not a string array', () => {
		// @ts-expect-error allow must be a string array
		new MethodNotAllowedException('m', { allow: 1 });
	});
});
