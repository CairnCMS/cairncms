import { BaseException } from '@cairncms/exceptions';
import { ZodError } from 'zod';
import logger from '../logger.js';
import type { WebSocketResponse } from './messages.js';

export type WebSocketErrorCode =
	| 'AUTH_FAILED'
	| 'TOKEN_EXPIRED'
	| 'INVALID_PAYLOAD'
	| 'REQUESTS_EXCEEDED'
	| 'UNSUPPORTED_MESSAGE_TYPE'
	| 'TOO_MANY_PENDING'
	| 'INTERNAL_ERROR';

const ERROR_MESSAGES: Record<WebSocketErrorCode, string> = {
	AUTH_FAILED: 'Authentication failed.',
	TOKEN_EXPIRED: 'Token expired.',
	INVALID_PAYLOAD: 'Invalid message.',
	REQUESTS_EXCEEDED: 'Too many requests.',
	UNSUPPORTED_MESSAGE_TYPE: 'Unsupported message type.',
	TOO_MANY_PENDING: 'Too many pending commands.',
	INTERNAL_ERROR: 'Request failed.',
};

const ALLOWLISTED_CODES = new Set<string>(Object.keys(ERROR_MESSAGES));

const LOG_UNHANDLED = 'WEBSOCKET_UNHANDLED_EXCEPTION';

export class WebSocketException extends Error {
	readonly type: string;
	readonly code: WebSocketErrorCode;
	readonly uid: string | number | undefined;

	constructor(type: string, code: WebSocketErrorCode, uid?: string | number) {
		super(ERROR_MESSAGES[code]);
		this.type = type;
		this.code = code;
		this.uid = uid;
	}

	toResponse(): WebSocketResponse {
		const response: WebSocketResponse = {
			type: this.type,
			status: 'error',
			error: { code: this.code, message: ERROR_MESSAGES[this.code] },
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

	if (error instanceof BaseException && ALLOWLISTED_CODES.has(error.code)) {
		return new WebSocketException(type, error.code as WebSocketErrorCode, uid);
	}

	logger.debug(LOG_UNHANDLED);
	return new WebSocketException(type, 'INTERNAL_ERROR', uid);
}
