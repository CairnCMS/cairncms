import type { RestCommand } from '../../types.js';
import type { ConfigDocument } from './snapshot.js';

export type ConfigApplyOptions = {
	dryRun?: boolean;
	destructive?: boolean;
	forceSchema?: boolean;
};

export type ConfigPlanOutput = {
	planVersion: 2 | 3;
	manifestVersion: number;
	changes: Record<string, any>[];
	summary: { create: number; update: number; delete: number };
	preparation?: string[];
	warnings: Record<string, any>[];
	protections: Record<string, any>[];
};

export type ConfigApplyStepStatus = 'not_run' | 'skipped' | 'committed' | 'rolled_back' | 'failed' | 'unknown';

export type ConfigApplySteps = {
	folders: ConfigApplyStepStatus;
	schema: ConfigApplyStepStatus;
	configuration: ConfigApplyStepStatus;
};

/** A mutating apply's outcome. Use `meta.result` and `meta.steps` to determine what was applied, because `data` can be null when a step committed. */
export type ConfigApplyOutput = {
	data: Record<string, any> | null;
	meta: {
		plan: ConfigPlanOutput;
		result: 'applied' | 'no_changes';
		steps: ConfigApplySteps;
	};
};

/**
 * Preview applying a config document without changing the instance. This endpoint is only available to admin users.
 * @param document The desired config document.
 * @param options `dryRun` must be true. Deletions are previewed without `destructive`. `forceSchema` bypasses the schema release and database vendor checks, which also apply to a dry run.
 * @returns Returns the plan of intended changes.
 */
export function configApply<Schema>(
	document: ConfigDocument,
	options: ConfigApplyOptions & { dryRun: true }
): RestCommand<ConfigPlanOutput, Schema>;

/**
 * Apply a config document to the instance. This endpoint is only available to admin users.
 * @param document The desired config document.
 * @param options `destructive` allows deletions. `forceSchema` bypasses the schema release and database vendor checks.
 * @returns Returns the configuration step's result in `data`, null when a schema-managed run skipped that step, and the plan, overall result and step states in `meta`. Use `meta.result` and `meta.steps` to determine what was applied.
 */
export function configApply<Schema>(
	document: ConfigDocument,
	options?: ConfigApplyOptions & { dryRun?: false }
): RestCommand<ConfigApplyOutput, Schema>;

/**
 * Preview or apply a config document. This endpoint is only available to admin users.
 * @param document The desired config document.
 * @param options `dryRun` previews without changing the instance. `destructive` allows deletions when applying, and a dry run previews them without it. `forceSchema` bypasses the schema release and database vendor checks, which also apply to a dry run.
 * @returns Returns the plan for a dry run, or the apply outcome otherwise.
 */
export function configApply<Schema>(
	document: ConfigDocument,
	options?: ConfigApplyOptions
): RestCommand<ConfigPlanOutput | ConfigApplyOutput, Schema>;

export function configApply<Schema>(
	document: ConfigDocument,
	options: ConfigApplyOptions = {}
): RestCommand<ConfigPlanOutput | ConfigApplyOutput, Schema> {
	return () => {
		const params: Record<string, string> = {};

		if (options.dryRun === true) params['dry_run'] = 'true';
		if (options.destructive === true) params['destructive'] = 'true';
		if (options.forceSchema === true) params['force_schema'] = 'true';

		return {
			method: 'POST',
			path: '/config/apply',
			params,
			body: JSON.stringify(document),
			...(options.dryRun !== true && { envelope: true as const }),
		};
	};
}
