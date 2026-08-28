import { BaseException } from '@cairncms/exceptions';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import logger from '../logger.js';
import { toWebSocketException, WebSocketException } from './exceptions.js';

describe('WebSocketException', () => {
	it('serializes a fixed-message error frame with the code and uid', () => {
		const frame = JSON.parse(new WebSocketException('auth', 'AUTH_FAILED', 7).toMessage());

		expect(frame).toEqual({
			type: 'auth',
			status: 'error',
			uid: 7,
			error: { code: 'AUTH_FAILED', message: 'Authentication failed.' },
		});
	});

	it('omits the uid when not provided', () => {
		const frame = JSON.parse(new WebSocketException('server', 'INVALID_PAYLOAD').toMessage());
		expect(frame.uid).toBeUndefined();
	});

	it('normalizes a malformed code to INTERNAL_ERROR so the wire never carries it', () => {
		const frame = JSON.parse(new WebSocketException('items', 'lowercase_code', 2).toMessage());
		expect(frame.error.code).toBe('INTERNAL_ERROR');
	});
});

describe('toWebSocketException', () => {
	it('passes a WebSocketException through unchanged', () => {
		const original = new WebSocketException('auth', 'TOKEN_EXPIRED');
		expect(toWebSocketException(original, 'server')).toBe(original);
	});

	it('maps a ZodError to INVALID_PAYLOAD', () => {
		expect(toWebSocketException(new ZodError([]), 'server').code).toBe('INVALID_PAYLOAD');
	});

	it('maps an allowlisted BaseException code and never echoes its message', () => {
		const result = toWebSocketException(new BaseException('token=secret-value', 400, 'INVALID_PAYLOAD'), 'server');

		expect(result.code).toBe('INVALID_PAYLOAD');
		expect(result.message).toBe('Invalid message.');
		expect(result.toMessage()).not.toContain('secret-value');
	});

	it('passes through a valid machine code with a redacted message', () => {
		const result = toWebSocketException(new BaseException('denied: token=secret-value', 403, 'FORBIDDEN'), 'items', 4);

		expect(result.code).toBe('FORBIDDEN');
		expect(result.message).toBe('You do not have permission to access this.');
		expect(result.toMessage()).not.toContain('secret-value');
		const frame = JSON.parse(result.toMessage());
		expect(frame).toMatchObject({ type: 'items', uid: 4, error: { code: 'FORBIDDEN' } });
	});

	it('maps a malformed code and an unknown error to INTERNAL_ERROR without leaking the raw error', () => {
		const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger);

		expect(toWebSocketException(new BaseException('boom-secret', 500, 'lowercase_code'), 'server').code).toBe(
			'INTERNAL_ERROR'
		);

		expect(toWebSocketException(new Error('raw-secret'), 'server').code).toBe('INTERNAL_ERROR');

		expect(debug).toHaveBeenCalled();
		const logged = debug.mock.calls.flat().map(String).join(' ');
		expect(logged).not.toContain('boom-secret');
		expect(logged).not.toContain('raw-secret');

		debug.mockRestore();
	});

	it('gives FORBIDDEN a fixed message', () => {
		expect(new WebSocketException('items', 'FORBIDDEN').message).toBe('You do not have permission to access this.');
	});
});
