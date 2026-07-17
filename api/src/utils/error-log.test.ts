import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { REDACT_TEXT } from '../constants.js';
import { buildLogProjection, createErrorSinkLogger, redactLogPayload } from './error-log.js';
import { snapshotError } from './error-snapshot.js';

function firstLine(lines: string[]): any {
	return JSON.parse(lines[0]!);
}

describe('buildLogProjection', () => {
	test('folds message and stack and drops cause and originalError', () => {
		const projection = buildLogProjection({
			type: 'InvalidPayloadException',
			message: 'outer',
			stack: 'stack-outer',
			status: 400,
			code: 'INVALID_PAYLOAD',
			extensions: { field: 'x' },
			cause: { type: 'Error', message: 'inner', stack: 'stack-inner' },
			originalError: { type: 'Error', message: 'orig' },
		}) as any;

		expect(projection.message).toBe('outer: inner');
		expect(projection.stack).toBe('stack-outer\ncaused by: stack-inner');
		expect(projection.type).toBe('InvalidPayloadException');
		expect(projection.status).toBe(400);
		expect(projection.extensions).toEqual({ field: 'x' });
		expect('cause' in projection).toBe(false);
		expect('originalError' in projection).toBe(false);
	});

	test('drops a non-error-like string cause instead of emitting it', () => {
		const projection = buildLogProjection({
			type: 'Error',
			message: 'boom',
			stack: 'stack',
			cause: 'a string reason',
		}) as any;

		expect('cause' in projection).toBe(false);
		expect(projection.message).toBe('boom');
	});

	test('drops a cause object that has no message', () => {
		const projection = buildLogProjection({
			type: 'Error',
			message: 'boom',
			stack: 'stack',
			cause: { code: 'NO_MESSAGE' },
		}) as any;

		expect('cause' in projection).toBe(false);
	});

	test('recursively projects aggregate errors, folding and dropping their causes', () => {
		const projection = buildLogProjection({
			type: 'AggregateError',
			message: 'multi',
			stack: 'agg-stack',
			aggregateErrors: [
				{ type: 'Error', message: 'a', stack: 'sa', cause: { type: 'Error', message: 'a-cause', stack: 'sac' } },
			],
		}) as any;

		expect(projection.aggregateErrors[0].message).toBe('a: a-cause');
		expect('cause' in projection.aggregateErrors[0]).toBe(false);
	});

	test('matches pino output for a real error with a cause', () => {
		class InvalidPayloadException extends Error {
			status = 400;
			code = 'INVALID_PAYLOAD';
			extensions = { field: 'token' };
		}

		const error = new InvalidPayloadException('outer boom');
		error.cause = new Error('inner boom');

		const projection = buildLogProjection(snapshotError(error));

		const lines: string[] = [];
		pino({}, { write: (s: string) => lines.push(s) }).error(error);
		const pinoErr = firstLine(lines).err;

		expect(projection).toEqual(pinoErr);
	});
});

describe('redactLogPayload', () => {
	test('redacts the projection and sets msg to the redacted own message', () => {
		const secret = 'super-secret-token-value';

		const { err, msg } = redactLogPayload(
			{
				type: 'Error',
				message: `failed for ${secret}`,
				stack: `Error: failed for ${secret}\n  at x`,
				extensions: { access_token: secret },
			},
			new Set([secret])
		);

		expect(err['message']).toBe(`failed for ${REDACT_TEXT}`);
		expect((err['extensions'] as any).access_token).toBe(REDACT_TEXT);
		expect(err['stack']).not.toContain(secret);
		expect(msg).toBe(`failed for ${REDACT_TEXT}`);
	});

	test('keeps benign cause text while scrubbing the secret from the folded message', () => {
		const secret = 'cause-secret-abcdef';

		const { err } = redactLogPayload(
			{
				type: 'Error',
				message: 'outer failed',
				stack: 'outer-stack',
				cause: {
					type: 'Error',
					message: `inner failed for ${secret}`,
					stack: `inner-stack ${secret}`,
					extensions: { password: secret },
				},
			},
			new Set([secret])
		);

		expect(err['message']).toBe(`outer failed: inner failed for ${REDACT_TEXT}`);
		expect(err['stack']).toContain('caused by:');
		expect(err['stack']).not.toContain(secret);
	});
});

describe('createErrorSinkLogger', () => {
	test('logs a projection verbatim without relabeling the type', () => {
		const lines: string[] = [];
		const sink = createErrorSinkLogger(pino({}, { write: (s: string) => lines.push(s) }));

		sink.error({ err: { type: 'InvalidPayloadException', message: 'boom', code: 'X' } }, 'boom');

		const parsed = firstLine(lines);
		expect(parsed.err.type).toBe('InvalidPayloadException');
		expect(parsed.err.code).toBe('X');
		expect(parsed.msg).toBe('boom');
	});

	test('a default logger relabels the type to Object, which the identity serializer prevents', () => {
		const lines: string[] = [];

		pino({}, { write: (s: string) => lines.push(s) }).error(
			{ err: { type: 'InvalidPayloadException', message: 'boom' } },
			'boom'
		);

		expect(firstLine(lines).err.type).toBe('Object');
	});
});
