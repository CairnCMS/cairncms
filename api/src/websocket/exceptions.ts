import { BaseException } from '@cairncms/exceptions';
import { ZodError } from 'zod';
import logger from '../logger.js';
import type { WebSocketResponse } from './messages.js';

export type WebSocketErrorCode =
	| 'AUTH_FAILED'
	| 'TOKEN_EXPIRED'
	| 'INVALID_PAYLOAD'
	| 'FAILED_VALIDATION'
	| 'FORBIDDEN'
	| 'REQUESTS_EXCEEDED'
	| 'UNSUPPORTED_MESSAGE_TYPE'
	| 'TOO_MANY_PENDING'
	| 'SUBSCRIPTION_LIMIT'
	| 'DELETE_FEED_FORBIDDEN'
	| 'INTERNAL_ERROR';

const ERROR_MESSAGES: Record<WebSocketErrorCode, string> = {
	AUTH_FAILED: 'Authentication failed.',
	TOKEN_EXPIRED: 'Token expired.',
	INVALID_PAYLOAD: 'Invalid message.',
	FAILED_VALIDATION: 'The payload failed validation.',
	FORBIDDEN: 'You do not have permission to access this.',
	REQUESTS_EXCEEDED: 'Too many requests.',
	UNSUPPORTED_MESSAGE_TYPE: 'Unsupported message type.',
	TOO_MANY_PENDING: 'Too many pending commands.',
	SUBSCRIPTION_LIMIT: 'Too many subscriptions.',
	DELETE_FEED_FORBIDDEN: 'Delete notifications are not available for this subscription.',
	INTERNAL_ERROR: 'Request failed.',
};

const GENERIC_MESSAGE = 'The request could not be completed.';

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const LOG_UNHANDLED = 'WEBSOCKET_UNHANDLED_EXCEPTION';

function messageForCode(code: string): string {
	return (ERROR_MESSAGES as Record<string, string>)[code] ?? GENERIC_MESSAGE;
}

/** Returns the code shared by every exception in a list, or null for an empty list or one with mixed codes or non-exceptions. */
function sharedCode(errors: unknown[]): string | null {
	const [first] = errors;

	if (!(first instanceof BaseException) || !CODE_PATTERN.test(first.code)) return null;

	return errors.every((error) => error instanceof BaseException && error.code === first.code) ? first.code : null;
}

export class WebSocketException extends Error {
	readonly type: string;
	readonly code: string;
	readonly uid: string | number | undefined;

	constructor(type: string, code: WebSocketErrorCode | string, uid?: string | number) {
		const safeCode = CODE_PATTERN.test(code) ? code : 'INTERNAL_ERROR';
		super(messageForCode(safeCode));
		this.type = type;
		this.code = safeCode;
		this.uid = uid;
	}

	toResponse(): WebSocketResponse {
		const response: WebSocketResponse = {
			type: this.type,
			status: 'error',
			error: { code: this.code, message: messageForCode(this.code) },
		};

		if (this.uid !== undefined) response.uid = this.uid;

		return response;
	}

	toMessage(): string {
		return JSON.stringify(this.toResponse());
	}
}

export function toWebSocketException(error: unknown, type: string, uid?: string | number): WebSocketException {
	if (error instanceof WebSocketException) return error;

	if (error instanceof ZodError) return new WebSocketException(type, 'INVALID_PAYLOAD', uid);

	if (error instanceof BaseException && CODE_PATTERN.test(error.code)) {
		return new WebSocketException(type, error.code, uid);
	}

	if (Array.isArray(error)) {
		const code = sharedCode(error);
		if (code !== null) return new WebSocketException(type, code, uid);
	}

	logger.debug(LOG_UNHANDLED);
	return new WebSocketException(type, 'INTERNAL_ERROR', uid);
}
