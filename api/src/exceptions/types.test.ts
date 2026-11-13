import { BaseException } from '@cairncms/exceptions';
import { describe, expectTypeOf, it } from 'vitest';

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
