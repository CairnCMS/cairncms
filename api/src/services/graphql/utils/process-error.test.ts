import type { Accountability } from '@cairncms/types';
import { GraphQLError } from 'graphql';
import { afterEach, describe, expect, test, vi } from 'vitest';

const loggedPayloads: Array<{ level: string; err: any; msg: string | undefined }> = [];

vi.doMock('../../../env', () => {
	const MOCK_ENV = { NODE_ENV: 'test', LOG_LEVEL: 'info', LOG_STYLE: 'raw' };

	return { default: MOCK_ENV, getEnv: () => MOCK_ENV };
});

vi.doMock('../../../utils/error-log', async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import('../../../utils/error-log.js');

	return {
		...actual,
		logRedactedError: vi.fn((level: string, snapshot: any, set: Set<string>, keys?: Set<string>) => {
			const { err, msg } = actual.redactLogPayload(snapshot, set, keys);
			loggedPayloads.push({ level, err, msg });
		}),
	};
});

const { default: formatGraphqlErrors } = await import('./process-error.js');

const { logRedactedError: logSpy } = (await import('../../../utils/error-log.js')) as unknown as {
	logRedactedError: ReturnType<typeof vi.fn>;
};

const { InvalidPayloadException } = await import('../../../exceptions/index.js');
const { REDACT_TEXT } = await import('../../../constants.js');

const SECRET = 'super-secret-token-value-1234567890';
const ADMIN: Accountability = { role: null, admin: true };
const NON_ADMIN: Accountability = { role: null };

afterEach(() => {
	loggedPayloads.length = 0;
	vi.clearAllMocks();
});

describe('formatGraphqlErrors', () => {
	test('redacts a BaseException originalError message and extensions in the response', () => {
		const inner = new InvalidPayloadException(`bad ${SECRET}`, { access_token: SECRET });

		const [formatted] = formatGraphqlErrors(
			[new GraphQLError('wrapper', { originalError: inner })],
			undefined,
			NON_ADMIN
		);

		expect(formatted!.message).toBe(`bad ${REDACT_TEXT}`);
		expect(formatted!.extensions?.['code']).toBe('INVALID_PAYLOAD');
		expect(formatted!.extensions?.['access_token']).toBe(REDACT_TEXT);
	});

	test('admin sees a redacted internal error with path, non-admin sees the generic error', () => {
		const error = new GraphQLError(`failed for ${SECRET}`, { path: ['col'] });

		const [adminFormatted] = formatGraphqlErrors([error], { password: SECRET }, ADMIN);
		expect(adminFormatted!.message).toBe(`failed for ${REDACT_TEXT}`);
		expect(adminFormatted!.path).toEqual(['col']);
		expect(adminFormatted!.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR');

		const [userFormatted] = formatGraphqlErrors([error], { password: SECRET }, null);
		expect(userFormatted!.message).toBe('An unexpected error occurred.');
		expect(userFormatted!.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
	});

	test('redacts a variable secret echoed into the response and the log projection', () => {
		const error = new GraphQLError(`token ${SECRET} rejected`, { path: ['col'] });

		const [formatted] = formatGraphqlErrors([error], { access_token: SECRET }, ADMIN);

		expect(formatted!.message).toBe(`token ${REDACT_TEXT} rejected`);
		expect(loggedPayloads[0]!.err['message']).toBe(`token ${REDACT_TEXT} rejected`);
	});

	test('cross-error: a secret only in one error message is redacted in both the response and its log', () => {
		const errA = new GraphQLError(`context ${SECRET}`);

		const errB = new GraphQLError('wrap', {
			originalError: new InvalidPayloadException('x', { access_token: SECRET }),
		});

		const formatted = formatGraphqlErrors([errA, errB], undefined, ADMIN);

		expect(JSON.stringify(formatted)).not.toContain(SECRET);
		expect(loggedPayloads[0]!.err['message']).toBe(`context ${REDACT_TEXT}`);
	});

	test('logs each unexpected error at error level', () => {
		formatGraphqlErrors([new GraphQLError('a'), new GraphQLError('b')], undefined, null);

		expect(logSpy).toHaveBeenCalledTimes(2);
		expect(logSpy).toHaveBeenCalledWith('error', expect.any(Object), expect.any(Set));
	});

	test('logs an expected BaseException-originated error at debug level', () => {
		formatGraphqlErrors(
			[new GraphQLError('wrap', { originalError: new InvalidPayloadException('x') })],
			undefined,
			null
		);

		expect(logSpy).toHaveBeenCalledWith('debug', expect.any(Object), expect.any(Set));
		expect(logSpy).not.toHaveBeenCalledWith('error', expect.any(Object), expect.any(Set));
	});

	test('reads originalError exactly once and does not leak a stateful value to a non-admin', () => {
		const generic = Object.assign(new Error('generic detail'), { extensions: { access_token: SECRET } });
		const baseException = new InvalidPayloadException('safe');
		let reads = 0;

		const error = new GraphQLError('wrap');

		Object.defineProperty(error, 'originalError', {
			configurable: true,
			enumerable: true,
			get() {
				reads++;
				return reads === 1 ? generic : baseException;
			},
		});

		const [formatted] = formatGraphqlErrors([error], undefined, null);

		expect(reads).toBe(1);
		expect(formatted!.message).toBe('An unexpected error occurred.');
		expect(formatted!.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
	});

	test('fails closed to a single generic error and logs a marker when formatting throws', () => {
		const hostile = new GraphQLError('x');

		Object.defineProperty(hostile, 'boom', {
			enumerable: true,
			get() {
				throw new Error('hostile getter');
			},
		});

		const formatted = formatGraphqlErrors([hostile], undefined, ADMIN);

		expect(formatted).toEqual([
			{ message: 'An unexpected error occurred.', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
		]);

		expect(logSpy).toHaveBeenCalledWith(
			'error',
			expect.objectContaining({ type: 'GraphQLErrorFormattingFailure' }),
			expect.any(Set)
		);
	});
});
