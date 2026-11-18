import {
	BaseException,
	FailedValidationException,
	ForbiddenException,
	joiValidationErrorItemToErrorExtensions,
	MethodNotAllowedException,
	ServiceUnavailableException,
	type FailedValidationType,
} from '@cairncms/exceptions';
import type { ClientFilterOperator } from '@cairncms/types';
import { validatePayload } from '@cairncms/utils';
import Joi from 'joi';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SchemaPersistedState } from '../types/index.js';
import { ConfigFolderInUseException, type FolderBlocker } from './config-folder-in-use.js';
import { ConfigPostCommitFailedException } from './config-post-commit-failed.js';
import { ConfigProtectedRecordException } from './config-protected-record.js';
import { RecordNotUniqueException } from './database/record-not-unique.js';
import { DestructiveChangesRequiredException } from './destructive-changes-required.js';
import { SchemaApplyFailedException } from './schema-apply-failed.js';

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

describe('ForbiddenException details typing', () => {
	it('starts without details and leaves metadata added later unknown', () => {
		const error = new ForbiddenException();

		expectTypeOf(error.extensions['code']).toEqualTypeOf<unknown>();

		// @ts-expect-error metadata added after construction must be narrowed before use
		const code: string = error.extensions['code'];

		expect(code).toBeUndefined();
	});
});

describe('FailedValidationException details typing', () => {
	it('carries no compared or submitted value in its details', () => {
		const item = validatePayload({ published: { _eq: true } }, { published: false })[0]!.details[0]!;
		const error = new FailedValidationException(item);

		expectTypeOf(error.extensions).not.toHaveProperty('valid');
		expectTypeOf(error.extensions).not.toHaveProperty('invalid');
		expectTypeOf(error.extensions).not.toHaveProperty('substring');
		expect(error.extensions).toStrictEqual({ field: 'published', type: 'eq' });
	});

	it('types the rule as one the constructor produces, which readers can still treat as a client filter operator', () => {
		const item = validatePayload({ published: { _eq: true } }, { published: false })[0]!.details[0]!;
		const error = new FailedValidationException(item);

		expectTypeOf(error.extensions.type).toMatchTypeOf<ClientFilterOperator | 'required' | undefined>();

		// @ts-expect-error the constructor never produces a between rule
		const rule: typeof error.extensions.type = 'between';

		expect(error.extensions.type).toBe('eq');
		expect(rule).toBe('between');
	});

	it('keeps the first path component, which can be a number or absent', () => {
		const fromArray = new FailedValidationException(Joi.array().items(Joi.string()).validate([123]).error!.details[0]!);

		const fromObject = new FailedValidationException(
			Joi.object({ name: Joi.string() }).validate({ name: 123 }).error!.details[0]!
		);

		const fromRoot = new FailedValidationException(Joi.string().validate(123).error!.details[0]!);

		expectTypeOf(fromArray.extensions.field).toEqualTypeOf<string | number | undefined>();
		expect(fromObject.extensions.field).toBe('name');
		expect(fromRoot.extensions).toStrictEqual({ field: undefined });

		// @ts-expect-error an array item's path starts with its index
		const field: string | undefined = fromArray.extensions.field;

		expect(field).toBe(0);
	});

	it('types the rule as possibly absent and the field as possibly undefined in converted details', () => {
		const unclassified = joiValidationErrorItemToErrorExtensions(
			validatePayload({ title: { _starts_with: 'a' } }, { title: 42 })[0]!.details[0]!
		);

		const root = joiValidationErrorItemToErrorExtensions(Joi.string().validate(123).error!.details[0]!);

		expectTypeOf(unclassified.type).toEqualTypeOf<FailedValidationType | undefined>();
		expectTypeOf(root.field).toEqualTypeOf<string | number | undefined>();
		expect(unclassified).toStrictEqual({ field: 'title' });
		expect(root).toStrictEqual({ field: undefined });
	});
});

describe('config and schema exception details typing', () => {
	it('types the persisted state of a failed schema apply', () => {
		const error: unknown = new SchemaApplyFailedException('unknown');

		if (!(error instanceof SchemaApplyFailedException)) throw error;

		expectTypeOf(error.extensions.persisted).toEqualTypeOf<SchemaPersistedState | 'unknown'>();
	});

	it('types the blocker of a folder still in use', () => {
		const error: unknown = new ConfigFolderInUseException('m', { blockedBy: 'files' });

		if (!(error instanceof ConfigFolderInUseException)) throw error;

		expectTypeOf(error.extensions.blockedBy).toEqualTypeOf<FolderBlocker | undefined>();
	});

	it('rejects a folder blocker that the deletion guard never reports', () => {
		// @ts-expect-error the blocker must be a known folder reference
		new ConfigFolderInUseException('m', { blockedBy: 'unknown-blocker' });
	});

	it('rejects deletions that are not plan deletions', () => {
		// @ts-expect-error deletions must be a list of plan deletions
		new DestructiveChangesRequiredException('m', { deletions: 'x' });
	});

	it('rejects a protection contributor that is not a role change', () => {
		new ConfigProtectedRecordException('m', {
			protection: { code: 'ADMIN_CONTINUITY_REQUIRED' },
			// @ts-expect-error contributors must be role changes with an operation and identity
			contributors: [{ kind: 'users' }],
		});
	});

	it('rejects an unknown post-commit phase', () => {
		// @ts-expect-error the phase must be a config post-commit phase
		new ConfigPostCommitFailedException('bogus');
	});
});

describe('ServiceUnavailableException details typing', () => {
	it('can be raised with only a message', () => {
		const error = new ServiceUnavailableException('The upstream service is unavailable.');

		expectTypeOf(error.extensions.service).toEqualTypeOf<string | undefined>();
		expect(error.extensions).toStrictEqual({});
	});

	it('rejects a message that is not a string', () => {
		// @ts-expect-error the message must be a string
		new ServiceUnavailableException(1);
	});
});
