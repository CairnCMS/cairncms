import { BaseException } from '@cairncms/exceptions';
import type { Accountability } from '@cairncms/types';
import type { GraphQLError, GraphQLFormattedError } from 'graphql';
import { isPlainObject } from 'lodash-es';
import { logRedactedError } from '../../../utils/error-log.js';
import { snapshotError } from '../../../utils/error-snapshot.js';
import { collectSensitiveValuesExhaustive, redactSensitive } from '../../../utils/redact-sensitive.js';

const FALLBACK_ERROR: GraphQLFormattedError = {
	message: 'An unexpected error occurred.',
	extensions: { code: 'INTERNAL_SERVER_ERROR' },
};

function objectAt(source: Record<string, unknown>, key: string): Record<string, unknown> {
	return isPlainObject(source[key]) ? (source[key] as Record<string, unknown>) : {};
}

function baseExceptionError(snapshot: Record<string, unknown>): Record<string, unknown> {
	const originalError = objectAt(snapshot, 'originalError');

	return {
		message: originalError['message'],
		extensions: { code: originalError['code'], ...objectAt(originalError, 'extensions') },
	};
}

function internalError(
	snapshot: Record<string, unknown>,
	accountability: Accountability | null
): Record<string, unknown> {
	if (accountability?.admin !== true) {
		return { message: 'An unexpected error occurred.', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
	}

	const formatted: Record<string, unknown> = {
		message: snapshot['message'],
		extensions: { code: 'INTERNAL_SERVER_ERROR' },
	};

	if (snapshot['locations']) formatted['locations'] = snapshot['locations'];
	if (snapshot['path']) formatted['path'] = snapshot['path'];

	return formatted;
}

function processError(
	snapshot: Record<string, unknown>,
	originalErrorIsBaseException: boolean,
	accountability: Accountability | null,
	sensitiveValues: ReadonlySet<string>
): GraphQLFormattedError {
	logRedactedError(originalErrorIsBaseException ? 'debug' : 'error', snapshot, sensitiveValues);

	const formatted = originalErrorIsBaseException
		? baseExceptionError(snapshot)
		: internalError(snapshot, accountability);

	return redactSensitive(formatted, sensitiveValues) as unknown as GraphQLFormattedError;
}

/** Redacts a GraphQL result's errors over one sensitive set for the whole result, or returns a single generic error if formatting fails. */
export default function formatGraphqlErrors(
	errors: readonly GraphQLError[],
	variables: unknown,
	accountability: Accountability | null
): GraphQLFormattedError[] {
	try {
		const classified = errors.map((error) => {
			// Read originalError once: snapshotError skips it (never invoking its accessor), so this
			// is the only read, keeping classification and materialization consistent.
			const originalError = error.originalError;
			const snapshot = snapshotError(error);

			if (originalError !== undefined) {
				snapshot['originalError'] = snapshotError(originalError);
			}

			return { snapshot, originalErrorIsBaseException: originalError instanceof BaseException };
		});

		const sensitiveValues = collectSensitiveValuesExhaustive(variables);

		for (const { snapshot } of classified) {
			for (const value of collectSensitiveValuesExhaustive(snapshot)) sensitiveValues.add(value);
		}

		return classified.map(({ snapshot, originalErrorIsBaseException }) =>
			processError(snapshot, originalErrorIsBaseException, accountability, sensitiveValues)
		);
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
