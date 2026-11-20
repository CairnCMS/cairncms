import type { ConfigRunStepFailure, ConfigRunSteps } from '../../../utils/config/run-record.js';

function persistedFacets(failure: ConfigRunStepFailure | undefined): string[] {
	const detail = failure?.detail;
	if (detail === undefined || !('persisted' in detail) || detail.persisted === 'unknown') return [];

	const { collections, fields, relations } = detail.persisted;

	return [
		...collections.flatMap((entry) => [entry.table, entry.metadata]),
		...fields.flatMap((entry) => [entry.column, entry.metadata]),
		...relations.flatMap((entry) => [entry.foreignKey, entry.metadata]),
	];
}

/**
 * Reports whether a failed run changed the target and whether its outcome is uncertain. A failed step without persisted
 * detail on a server error leaves its writes unaccounted for, so it is treated as uncertain even though it is labeled
 * failed.
 */
export function failureOutcome(
	steps: ConfigRunSteps,
	failure: ConfigRunStepFailure | undefined,
	refusal: boolean
): { changed: boolean; uncertain: boolean } {
	const statuses = [steps.folders, steps.schema, steps.configuration];
	const facets = persistedFacets(failure);
	const detail = failure?.detail;
	const persistedUnknown = detail !== undefined && 'persisted' in detail && detail.persisted === 'unknown';
	const failedStep = failure === undefined ? undefined : steps[failure.step];

	return {
		changed: statuses.some((status) => status === 'committed' || status === 'unknown') || facets.includes('applied'),
		uncertain:
			statuses.includes('unknown') ||
			persistedUnknown ||
			facets.includes('unknown') ||
			(!refusal && failedStep === 'failed' && !(detail !== undefined && 'persisted' in detail)),
	};
}

/** The exit code of a failed run, shared by the local and remote CLI: `2` only for a refusal that changed nothing. */
export function failureExitCode(
	steps: ConfigRunSteps,
	failure: ConfigRunStepFailure | undefined,
	refusal: boolean
): 2 | 3 {
	const { changed, uncertain } = failureOutcome(steps, failure, refusal);

	return changed || uncertain || !refusal ? 3 : 2;
}
