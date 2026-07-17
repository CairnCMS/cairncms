import { afterEach, describe, expect, test, vi } from 'vitest';

const getDatabaseMock = vi.fn(() => ({}));
const loggedPayloads: Array<{ level: string; err: any; msg: string | undefined }> = [];

vi.doMock('../env', () => {
	const MOCK_ENV = { NODE_ENV: 'test', LOG_LEVEL: 'info', LOG_STYLE: 'raw' };

	return { default: MOCK_ENV, getEnv: () => MOCK_ENV };
});

vi.doMock('../database/index', () => ({ default: getDatabaseMock }));

vi.doMock('../utils/error-log', async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import('../utils/error-log.js');

	return {
		...actual,
		// Delegate through the real redaction so the captured payload proves the handler passed
		// the correct sensitive set, without emitting to the app logger.
		logRedactedError: vi.fn((level: string, snapshot: any, set: Set<string>, keys?: Set<string>) => {
			const { err, msg } = actual.redactLogPayload(snapshot, set, keys);
			loggedPayloads.push({ level, err, msg });
		}),
	};
});

const { default: errorHandler } = await import('./error-handler.js');

const { logRedactedError: logSpy } = (await import('../utils/error-log.js')) as unknown as {
	logRedactedError: ReturnType<typeof vi.fn>;
};

const { InvalidPayloadException, MethodNotAllowedException } = await import('../exceptions/index.js');
const { default: emitter } = await import('../emitter.js');
const { REDACT_TEXT } = await import('../constants.js');

const SECRET = 'super-secret-token-value-1234567890';

const FALLBACK = {
	errors: [{ message: 'An unexpected error occurred.', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
};

function makeRes() {
	const res: any = {
		statusCode: 200,
		headersSent: false,
		headers: {} as Record<string, string>,
		body: undefined as any,
		status(code: number) {
			this.statusCode = code;
			return this;
		},
		header(name: string, value: string) {
			this.headers[name] = value;
			return this;
		},
		removeHeader(name: string) {
			delete this.headers[name];
			return this;
		},
		json(body: any) {
			this.headersSent = true;
			this.body = body;
			return this;
		},
	};

	return res;
}

function makeReq(overrides: Record<string, unknown> = {}): any {
	return {
		token: null,
		cookies: {},
		headers: {},
		query: {},
		body: undefined,
		accountability: null,
		schema: {},
		...overrides,
	};
}

async function runHandler(err: unknown, req = makeReq()): Promise<ReturnType<typeof makeRes>> {
	const res = makeRes();
	errorHandler(err, req, res, () => undefined);
	await new Promise((resolve) => setImmediate(resolve));
	return res;
}

const registeredFilters: Array<(...args: any[]) => any> = [];

function onRequestError(handler: (...args: any[]) => any): void {
	emitter.onFilter('request.error', handler);
	registeredFilters.push(handler);
}

afterEach(() => {
	for (const handler of registeredFilters.splice(0)) emitter.offFilter('request.error', handler);
	loggedPayloads.length = 0;
	getDatabaseMock.mockReturnValue({});
	vi.clearAllMocks();
});

describe('error-handler redaction', () => {
	test('redacts a secret from a BaseException response message and extensions', async () => {
		const res = await runHandler(new InvalidPayloadException(`bad token ${SECRET}`, { access_token: SECRET }));

		expect(res.statusCode).toBe(400);
		expect(res.body.errors[0].message).toBe(`bad token ${REDACT_TEXT}`);
		expect(res.body.errors[0].extensions.access_token).toBe(REDACT_TEXT);
		expect(res.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
	});

	test('admin gets a redacted detailed body for a non-BaseException, non-admin gets the generic body', async () => {
		const err = Object.assign(new Error(`boom ${SECRET}`), { extensions: { password: SECRET } });

		const adminRes = await runHandler(err, makeReq({ accountability: { admin: true } }));
		expect(adminRes.statusCode).toBe(500);
		expect(adminRes.body.errors[0].message).toBe(`boom ${REDACT_TEXT}`);
		expect(adminRes.body.errors[0].extensions.password).toBe(REDACT_TEXT);
		expect(adminRes.body.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');

		const userRes = await runHandler(err, makeReq({ accountability: { admin: false } }));
		expect(userRes.statusCode).toBe(500);
		expect(userRes.body.errors[0].message).toBe('An unexpected error occurred.');
		expect(userRes.body.errors[0].extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
	});

	test('logs the redacted projection at the right level with the real sensitive set', async () => {
		await runHandler(new InvalidPayloadException(`bad token ${SECRET}`, { access_token: SECRET }));

		expect(logSpy).toHaveBeenCalledWith(
			'debug',
			expect.objectContaining({ type: 'InvalidPayloadException' }),
			expect.any(Set)
		);

		const logged = loggedPayloads.find((entry) => entry.level === 'debug');
		expect(logged!.err['message']).toBe(`bad token ${REDACT_TEXT}`);
		expect((logged!.err['extensions'] as any).access_token).toBe(REDACT_TEXT);

		await runHandler(new Error('boom'));
		expect(logSpy).toHaveBeenCalledWith('error', expect.objectContaining({ type: 'Error' }), expect.any(Set));
	});

	test('sets the Allow header for a MethodNotAllowedException', async () => {
		const res = await runHandler(new MethodNotAllowedException('nope', { allow: ['GET', 'POST'] }));

		expect(res.statusCode).toBe(405);
		expect(res.headers['Allow']).toBe('GET, POST');
	});

	test('the request.error filter observes the unredacted error', async () => {
		let observed: any;

		onRequestError((errors: any) => {
			observed = errors;
			return errors;
		});

		await runHandler(new InvalidPayloadException(`bad ${SECRET}`, { access_token: SECRET }));

		expect(observed[0].extensions.access_token).toBe(SECRET);
	});

	test('redacts a secret the filter keeps in its output after dropping the key', async () => {
		onRequestError(() => [{ message: `leaked ${SECRET}`, extensions: { code: 'X' } }]);

		const res = await runHandler(new InvalidPayloadException(`bad ${SECRET}`, { access_token: SECRET }));

		expect(res.body.errors[0].message).toBe(`leaked ${REDACT_TEXT}`);
	});

	test('cross-error: a secret only in one error message is redacted because another error names it', async () => {
		const errA = new InvalidPayloadException(`context ${SECRET}`);
		const errB = new InvalidPayloadException('other', { access_token: SECRET });

		const res = await runHandler([errA, errB]);

		const combined = res.body.errors.map((entry: any) => JSON.stringify(entry)).join(' ');
		expect(combined).not.toContain(SECRET);
	});

	test('scrubs the bare request token from the response', async () => {
		const res = await runHandler(new InvalidPayloadException(`token was ${SECRET}`), makeReq({ token: SECRET }));

		expect(res.body.errors[0].message).toBe(`token was ${REDACT_TEXT}`);
	});

	test('fails closed and does not invoke the filter when preparation throws', async () => {
		const hostile = new InvalidPayloadException('x');

		Object.defineProperty(hostile, 'extensions', {
			enumerable: true,
			configurable: true,
			get() {
				throw new Error('boom getter');
			},
		});

		let filterCalled = false;

		onRequestError((errors: any) => {
			filterCalled = true;
			return errors;
		});

		const res = await runHandler(hostile);

		expect(res.statusCode).toBe(500);
		expect(res.body).toEqual(FALLBACK);
		expect(filterCalled).toBe(false);
	});

	test('delivers the fallback even when the fallback log throws', async () => {
		logSpy.mockImplementationOnce(() => {
			throw new Error('log boom');
		});

		const hostile = new InvalidPayloadException('x');

		Object.defineProperty(hostile, 'extensions', {
			enumerable: true,
			configurable: true,
			get() {
				throw new Error('boom getter');
			},
		});

		const res = await runHandler(hostile);

		expect(res.statusCode).toBe(500);
		expect(res.body).toEqual(FALLBACK);
	});

	test('fails closed when the filter context (getDatabase) throws', async () => {
		getDatabaseMock.mockImplementationOnce(() => {
			throw new Error('db down');
		});

		const res = await runHandler(new InvalidPayloadException('x'));

		expect(res.statusCode).toBe(500);
		expect(res.body).toEqual(FALLBACK);
	});

	test('fails closed when a request.error listener rejects', async () => {
		onRequestError(async () => {
			throw new Error('listener boom');
		});

		const res = await runHandler(new InvalidPayloadException('x'));

		expect(res.statusCode).toBe(500);
		expect(res.body).toEqual(FALLBACK);
	});

	test('fails closed when materializing the filter output throws, invoking the filter once', async () => {
		let calls = 0;

		onRequestError(() => {
			calls++;

			return [
				{
					toJSON() {
						throw new Error('materialize boom');
					},
				},
			];
		});

		const res = await runHandler(new InvalidPayloadException('x'));

		expect(res.statusCode).toBe(500);
		expect(res.body).toEqual(FALLBACK);
		expect(calls).toBe(1);
	});

	test('clears a stale Allow header when falling back after the filter', async () => {
		onRequestError(async () => {
			throw new Error('boom');
		});

		const res = await runHandler(new MethodNotAllowedException('nope', { allow: ['GET'] }));

		expect(res.statusCode).toBe(500);
		expect(res.headers['Allow']).toBeUndefined();
	});
});
