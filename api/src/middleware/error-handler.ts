import { BaseException } from '@cairncms/exceptions';
import { toArray } from '@cairncms/utils';
import type { ErrorRequestHandler, Request, Response } from 'express';
import { isPlainObject } from 'lodash-es';
import getDatabase from '../database/index.js';
import emitter from '../emitter.js';
import env from '../env.js';
import { MethodNotAllowedException } from '../exceptions/index.js';
import { collectRequestSecrets } from '../utils/collect-request-secrets.js';
import { logRedactedError } from '../utils/error-log.js';
import { snapshotError, toPlainData } from '../utils/error-snapshot.js';
import { collectSensitiveValuesExhaustive, redactSensitive } from '../utils/redact-sensitive.js';

const FALLBACK_BODY = {
	errors: [{ message: 'An unexpected error occurred.', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
};

type PreparedResponse = {
	status: number;
	allow: string | undefined;
	payloadErrors: unknown[];
	sensitiveValues: Set<string>;
};

function extensionsOf(snapshot: Record<string, unknown>): Record<string, unknown> {
	return isPlainObject(snapshot['extensions']) ? (snapshot['extensions'] as Record<string, unknown>) : {};
}

// Everything error-derived runs here, inside the caller's try, so a hostile getter or a
// redaction failure falls back rather than escaping the handler.
function prepareResponse(err: unknown, req: Request): PreparedResponse {
	const rawErrors: unknown[] = toArray(err);
	const isDevelopment = env['NODE_ENV'] === 'development';
	const isAdmin = req.accountability?.admin === true;

	const classified = rawErrors.map((rawError) => ({
		snapshot: snapshotError(rawError),
		isBase: rawError instanceof BaseException,
		isMethodNotAllowed: rawError instanceof MethodNotAllowedException,
	}));

	const sensitiveValues = collectRequestSecrets(req);

	for (const { snapshot } of classified) {
		for (const value of collectSensitiveValuesExhaustive(snapshot)) sensitiveValues.add(value);
	}

	let status: number;

	if (classified.some((entry) => !entry.isBase)) {
		status = 500;
	} else {
		status = classified[0]!.snapshot['status'] as number;

		for (const entry of classified) {
			if (status !== entry.snapshot['status']) {
				status = 500;
				break;
			}
		}
	}

	let payloadErrors: unknown[] = [];
	let allow: string | undefined;

	for (const { snapshot, isBase, isMethodNotAllowed } of classified) {
		if (isDevelopment) {
			snapshot['extensions'] = { ...extensionsOf(snapshot), stack: snapshot['stack'] };
		}

		logRedactedError(isBase ? 'debug' : 'error', snapshot, sensitiveValues);

		if (isBase) {
			status = snapshot['status'] as number;

			payloadErrors.push({
				message: snapshot['message'],
				extensions: { code: snapshot['code'], ...extensionsOf(snapshot) },
			});

			if (isMethodNotAllowed) {
				allow = (extensionsOf(snapshot)['allow'] as string[]).join(', ');
			}
		} else {
			status = 500;

			payloadErrors = isAdmin
				? [{ message: snapshot['message'], extensions: { code: 'INTERNAL_SERVER_ERROR', ...extensionsOf(snapshot) } }]
				: [{ message: 'An unexpected error occurred.', extensions: { code: 'INTERNAL_SERVER_ERROR' } }];
		}
	}

	return { status, allow, payloadErrors, sensitiveValues };
}

function sendFallback(res: Response): void {
	if (!res.headersSent) {
		res.removeHeader('Allow');
		res.status(500);
		res.json(FALLBACK_BODY);
	}

	try {
		logRedactedError(
			'error',
			{ type: 'ErrorHandlerFailure', message: 'Failed to prepare the error response' },
			new Set()
		);
	} catch {
		// A logging failure must not prevent the fallback response.
	}
}

// Note: keep all 4 parameters here. That's how Express recognizes it's the error handler, even if
// we don't use next
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
	let prepared: PreparedResponse;

	try {
		prepared = prepareResponse(err, req);
	} catch {
		sendFallback(res);
		return;
	}

	res.status(prepared.status);

	if (prepared.allow !== undefined) {
		res.header('Allow', prepared.allow);
	}

	// getDatabase() runs inside the promise so a synchronous context failure rejects into the
	// terminal catch rather than escaping the handler.
	Promise.resolve()
		.then(() =>
			emitter.emitFilter(
				'request.error',
				prepared.payloadErrors,
				{},
				{
					database: getDatabase(),
					schema: req.schema,
					accountability: req.accountability ?? null,
				}
			)
		)
		.then((updatedErrors) => {
			const sensitiveValues = new Set(prepared.sensitiveValues);
			const materialized = toPlainData(updatedErrors);

			for (const value of collectSensitiveValuesExhaustive(materialized)) sensitiveValues.add(value);

			res.json({ errors: redactSensitive(materialized, sensitiveValues) });
		})
		.catch(() => sendFallback(res));
};

export default errorHandler;
