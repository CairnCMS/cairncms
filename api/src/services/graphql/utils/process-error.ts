import { BaseException } from '@cairncms/exceptions';
import type { Accountability } from '@cairncms/types';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { isPlainObject } from 'lodash-es';
import { logRedactedError } from '../../../utils/error-log.js';
import { MAX_SNAPSHOT_DEPTH, snapshotError } from '../../../utils/error-snapshot.js';
import { collectSensitiveValuesExhaustive, redactSensitive } from '../../../utils/redact-sensitive.js';

const FALLBACK_ERROR: GraphQLFormattedError = {
	message: 'An unexpected error occurred.',
	extensions: { code: 'INTERNAL_SERVER_ERROR' },
};

const INCOMPLETE_CHAIN = 'The GraphQL error chain could not be inspected completely.';

type ClassifiedError = {
	snapshot: Record<string, unknown>;
	innermost: Record<string, unknown> | undefined;
	isBaseException: boolean;
};

function objectAt(source: Record<string, unknown>, key: string): Record<string, unknown> {
	return isPlainObject(source[key]) ? (source[key] as Record<string, unknown>) : {};
}

/**
 * Snapshots a result error and every `GraphQLError` layer beneath it, each nested under its wrapper's
 * `originalError`, and classifies the first value that is not a `GraphQLError`. Throws when the chain
 * repeats a layer or is longer than the snapshot depth.
 */
function classifyError(error: GraphQLError): ClassifiedError {
	const snapshot = snapshotError(error);
	const visited = new Set<unknown>([error]);
	let layer: GraphQLError = error;
	let layerSnapshot = snapshot;

	for (let depth = 0; depth < MAX_SNAPSHOT_DEPTH; depth++) {
		// Read each layer's originalError once: snapshotError skips it (never invoking its accessor), so
		// this is the only read, keeping classification and materialization consistent.
		const next: unknown = layer.originalError;

		if (next === undefined) return { snapshot, innermost: undefined, isBaseException: false };
		if (visited.has(next)) throw new Error(INCOMPLETE_CHAIN);

		const nextSnapshot = snapshotError(next);
		layerSnapshot['originalError'] = nextSnapshot;

		if (!(next instanceof GraphQLError)) {
			return { snapshot, innermost: nextSnapshot, isBaseException: next instanceof BaseException };
		}

		visited.add(next);
		layer = next;
		layerSnapshot = nextSnapshot;
	}

	throw new Error(INCOMPLETE_CHAIN);
}

function baseExceptionError(exception: Record<string, unknown>): Record<string, unknown> {
	return {
		message: exception['message'],
		extensions: { code: exception['code'], ...objectAt(exception, 'extensions') },
	};
}

function internalError(
	snapshot: Record<string, unknown>,
	accountability: Accountability | null
): Record<string, unknown> {
	if (accountability?.admin !== true) {
		return { message: 'An unexpected error occurred.', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
	}

	return { message: snapshot['message'], extensions: { code: 'INTERNAL_SERVER_ERROR' } };
}

function withLocation(formatted: Record<string, unknown>, snapshot: Record<string, unknown>): Record<string, unknown> {
	if (snapshot['locations']) formatted['locations'] = snapshot['locations'];
	if (snapshot['path']) formatted['path'] = snapshot['path'];

	return formatted;
}

function processError(
	{ snapshot, innermost, isBaseException }: ClassifiedError,
	accountability: Accountability | null,
	sensitiveValues: ReadonlySet<string>
): GraphQLFormattedError {
	logRedactedError(isBaseException ? 'debug' : 'error', snapshot, sensitiveValues);

	const formatted = redactSensitive(
		isBaseException && innermost ? baseExceptionError(innermost) : internalError(snapshot, accountability),
		sensitiveValues
	);

	// Attached after redaction, so a sensitive value that matches the caller's own field names or
	// positions cannot alter them.
	return withLocation(formatted, snapshot) as unknown as GraphQLFormattedError;
}

/** Redacts a GraphQL result's errors over one sensitive set for the whole result, or returns a single generic error if formatting fails. */
export default function formatGraphqlErrors(
	errors: readonly GraphQLError[],
	variables: unknown,
	accountability: Accountability | null
): GraphQLFormattedError[] {
	try {
		const classified = errors.map(classifyError);
		const sensitiveValues = collectSensitiveValuesExhaustive(variables);

		for (const { snapshot } of classified) {
			for (const value of collectSensitiveValuesExhaustive(snapshot)) sensitiveValues.add(value);
		}

		return classified.map((entry) => processError(entry, accountability, sensitiveValues));
	} catch {
		try {
			logRedactedError(
				'error',
				{ type: 'GraphQLErrorFormattingFailure', message: 'Failed to format the GraphQL errors' },
				new Set()
			);
		} catch {
			// A logging failure must not prevent the fallback.
		}

		return [FALLBACK_ERROR];
	}
}
