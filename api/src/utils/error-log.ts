import { type Logger, stdSerializers } from 'pino';
import baseLogger from '../logger.js';
import { redactSensitive } from './redact-sensitive.js';

/**
 * Projects a snapshot into pino's `err` shape using pino's own error serializer (which folds an
 * error-like cause chain into `message`/`stack`), then restores the captured `type` the serializer
 * relabels to `Object`, drops `cause` and `originalError`, and recursively projects aggregate errors.
 */
export function buildLogProjection(snapshot: Record<string, unknown>): Record<string, unknown> {
	const serialized = stdSerializers.err(snapshot as unknown as Error) as unknown as Record<string, unknown>;

	const projection: Record<string, unknown> = {};

	for (const [key, val] of Object.entries(serialized)) {
		if (key === 'cause' || key === 'originalError' || key === 'aggregateErrors') continue;
		projection[key] = val;
	}

	if ('type' in snapshot) projection['type'] = snapshot['type'];

	const aggregateErrors = snapshot['aggregateErrors'];

	if (Array.isArray(aggregateErrors)) {
		projection['aggregateErrors'] = aggregateErrors.map((sub) =>
			sub !== null && typeof sub === 'object' ? buildLogProjection(sub as Record<string, unknown>) : sub
		);
	}

	return projection;
}

/**
 * Builds the redacted log payload from a snapshot: the redacted `err` projection and the
 * redacted own `message` for `msg` (pino sets `msg` to the error's own message, not the folded one).
 */
export function redactLogPayload(
	snapshot: Record<string, unknown>,
	sensitiveValues: ReadonlySet<string>,
	extraSensitiveKeys?: ReadonlySet<string>
): { err: Record<string, unknown>; msg: string | undefined } {
	const err = redactSensitive(buildLogProjection(snapshot), sensitiveValues, extraSensitiveKeys);
	const ownMessage = snapshot['message'];

	const msg =
		typeof ownMessage === 'string' ? redactSensitive(ownMessage, sensitiveValues, extraSensitiveKeys) : undefined;

	return { err, msg };
}

/** A child logger whose `err` serializer is identity, so a prepared projection is logged verbatim. */
export function createErrorSinkLogger(logger: Logger): Logger {
	return logger.child({}, { serializers: { err: (value: unknown) => value } });
}

const errorSinkLogger = createErrorSinkLogger(baseLogger);

/** Logs a snapshot's redacted projection at the given level, preserving pino's `{ err, msg }` shape. */
export function logRedactedError(
	level: 'debug' | 'error',
	snapshot: Record<string, unknown>,
	sensitiveValues: ReadonlySet<string>,
	extraSensitiveKeys?: ReadonlySet<string>
): void {
	const { err, msg } = redactLogPayload(snapshot, sensitiveValues, extraSensitiveKeys);
	errorSinkLogger[level]({ err }, msg);
}
