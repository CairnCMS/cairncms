import type { Accountability, SchemaOverview } from '@cairncms/types';
import { GraphQLError, GraphQLObjectType, GraphQLSchema, GraphQLString, parse } from 'graphql';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { GraphQLParams } from '../../../types/index.js';

const loggedPayloads: Array<{ level: string; err: any; msg: string | undefined }> = [];

vi.doMock('../../../env', () => {
	const MOCK_ENV = {
		NODE_ENV: 'test',
		LOG_LEVEL: 'info',
		LOG_STYLE: 'raw',
		SECRET: 'x',
		EXTENSIONS_PATH: '/tmp',
		EMAIL_TEMPLATES_PATH: '/tmp',
		STORAGE_LOCATIONS: 'local',
	};

	return { default: MOCK_ENV, getEnv: () => MOCK_ENV };
});

vi.doMock('../../../database/index', () => ({ default: () => ({}) }));

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

const { InvalidPayloadException } = await import('@cairncms/exceptions');
const { REDACT_TEXT } = await import('../../../constants.js');
const { GraphQLService } = await import('../index.js');
const { MAX_SNAPSHOT_DEPTH } = await import('../../../utils/error-snapshot.js');

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

	test('admin sees a redacted internal error, non-admin sees the generic error, both with the path', () => {
		const error = new GraphQLError(`failed for ${SECRET}`, { path: ['col'] });

		const [adminFormatted] = formatGraphqlErrors([error], { password: SECRET }, ADMIN);
		expect(adminFormatted!.message).toBe(`failed for ${REDACT_TEXT}`);
		expect(adminFormatted!.path).toEqual(['col']);
		expect(adminFormatted!.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR');

		const [userFormatted] = formatGraphqlErrors([error], { password: SECRET }, null);
		expect(userFormatted!.message).toBe('An unexpected error occurred.');
		expect(userFormatted!.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
		expect(userFormatted!.path).toEqual(['col']);
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

describe('GraphQL errors as executed', () => {
	const schemaOverview: SchemaOverview = { collections: {}, relations: [] };

	async function executeMutation(field: string, accountability: Accountability) {
		const service = new GraphQLService({ accountability, schema: schemaOverview, scope: 'items' });

		const mutation = new GraphQLObjectType({
			name: 'Mutation',
			fields: {
				returned: {
					type: GraphQLString,
					resolve: () => service.formatError(new InvalidPayloadException('Returned failure.')),
				},
				thrown: {
					type: GraphQLString,
					resolve: () => {
						throw service.formatError(new InvalidPayloadException('Thrown failure.'));
					},
				},
				returnedArray: {
					type: GraphQLString,
					resolve: () =>
						service.formatError([
							new InvalidPayloadException('First failure.'),
							new InvalidPayloadException('Second failure.'),
						]),
				},
				direct: {
					type: GraphQLString,
					resolve: () => {
						throw new InvalidPayloadException('Direct failure.');
					},
				},
			},
		});

		vi.spyOn(service, 'getSchema').mockReturnValue(
			new GraphQLSchema({
				query: new GraphQLObjectType({ name: 'Query', fields: { ping: { type: GraphQLString } } }),
				mutation,
			})
		);

		const params: GraphQLParams = {
			query: null,
			variables: {},
			operationName: null,
			document: parse(`mutation { ${field} }`),
			contextValue: {},
		};

		const result = await service.execute(params);
		return { errors: result.errors, levels: loggedPayloads.map((payload) => payload.level) };
	}

	test.each([
		['returned', 'Returned failure.'],
		['thrown', 'Thrown failure.'],
		['returnedArray', 'First failure.'],
	])(
		'reports a formatError error from a %s mutation with the exception code and its location',
		async (field, message) => {
			for (const accountability of [ADMIN, NON_ADMIN]) {
				const { errors, levels } = await executeMutation(field, accountability);

				expect(errors).toEqual([
					{
						message,
						extensions: { code: 'INVALID_PAYLOAD' },
						locations: [{ line: 1, column: 12 }],
						path: [field],
					},
				]);

				expect(levels).toEqual(['debug']);
				loggedPayloads.length = 0;
			}
		}
	);

	test('reports a directly thrown exception with its code and its location', async () => {
		for (const accountability of [ADMIN, NON_ADMIN]) {
			const { errors, levels } = await executeMutation('direct', accountability);

			expect(errors).toEqual([
				{
					message: 'Direct failure.',
					extensions: { code: 'INVALID_PAYLOAD' },
					locations: [{ line: 1, column: 12 }],
					path: ['direct'],
				},
			]);

			expect(levels).toEqual(['debug']);
			loggedPayloads.length = 0;
		}
	});
});

describe('nested GraphQL error layers', () => {
	const FALLBACK = { message: 'An unexpected error occurred.', extensions: { code: 'INTERNAL_SERVER_ERROR' } };

	function wrap(inner: unknown, depth: number): GraphQLError {
		let error = new GraphQLError('layer', { originalError: inner as Error });
		for (let layer = 1; layer < depth; layer++) error = new GraphQLError('layer', { originalError: error });
		return error;
	}

	function expectFallback(formatted: unknown) {
		expect(formatted).toEqual([FALLBACK]);
		expect(loggedPayloads).toHaveLength(1);
		expect(loggedPayloads[0]!.err.type).toBe('GraphQLErrorFormattingFailure');
	}

	test('collects a secret marked only on an intermediate wrapper', () => {
		const exception = new InvalidPayloadException(`failed ${SECRET}`);
		const marked = new GraphQLError('marked', { originalError: exception, extensions: { password: SECRET } });
		const middle = new GraphQLError('middle', { originalError: marked, extensions: {} });
		const error = new GraphQLError('outer', { originalError: middle, extensions: {} });

		for (const accountability of [ADMIN, NON_ADMIN]) {
			const [formatted] = formatGraphqlErrors([error], undefined, accountability);

			expect(formatted!.message).toBe(`failed ${REDACT_TEXT}`);
			expect(formatted!.extensions?.['code']).toBe('INVALID_PAYLOAD');
		}

		expect(JSON.stringify(loggedPayloads)).not.toContain(SECRET);
	});

	test('reads each layer originalError exactly once', () => {
		const exception = new InvalidPayloadException('inner failure');
		const inner = new GraphQLError('inner');
		const outer = new GraphQLError('outer');
		const reads = { outer: 0, inner: 0 };

		Object.defineProperty(inner, 'originalError', {
			configurable: true,
			get() {
				reads.inner++;
				return exception;
			},
		});

		Object.defineProperty(outer, 'originalError', {
			configurable: true,
			get() {
				reads.outer++;
				return inner;
			},
		});

		const [formatted] = formatGraphqlErrors([outer], undefined, NON_ADMIN);

		expect(reads).toEqual({ outer: 1, inner: 1 });
		expect(formatted).toEqual({ message: 'inner failure', extensions: { code: 'INVALID_PAYLOAD' } });
	});

	test('keeps a wrapped value that is not an exception internal', () => {
		const error = wrap(new Error(`raw ${SECRET}`), 2);

		expect(formatGraphqlErrors([error], undefined, NON_ADMIN)).toEqual([FALLBACK]);
		expect(formatGraphqlErrors([error], undefined, ADMIN)[0]!.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
	});

	test('follows a chain up to the snapshot depth', () => {
		const [formatted] = formatGraphqlErrors(
			[wrap(new InvalidPayloadException('deep'), MAX_SNAPSHOT_DEPTH)],
			undefined,
			NON_ADMIN
		);

		expect(formatted).toEqual({ message: 'deep', extensions: { code: 'INVALID_PAYLOAD' } });
	});

	test('falls back when the chain is longer than the snapshot depth', () => {
		expectFallback(
			formatGraphqlErrors([wrap(new InvalidPayloadException('too deep'), MAX_SNAPSHOT_DEPTH + 1)], undefined, ADMIN)
		);
	});

	test('keeps the fallback free of location fields', () => {
		const error = new GraphQLError('outer', {
			path: ['field'],
			originalError: wrap(new Error('x'), MAX_SNAPSHOT_DEPTH),
		});

		expectFallback(formatGraphqlErrors([error], undefined, NON_ADMIN));
	});

	test('falls back when a layer repeats', () => {
		const first = new GraphQLError('first');
		const second = new GraphQLError('second', { originalError: first });
		Object.defineProperty(first, 'originalError', { configurable: true, value: second });

		expectFallback(formatGraphqlErrors([first], undefined, ADMIN));
	});

	test('falls back when a layer originalError cannot be read', () => {
		const inner = new GraphQLError('inner');

		Object.defineProperty(inner, 'originalError', {
			configurable: true,
			get() {
				throw new Error('hostile accessor');
			},
		});

		expectFallback(formatGraphqlErrors([new GraphQLError('outer', { originalError: inner })], undefined, ADMIN));
	});
});
