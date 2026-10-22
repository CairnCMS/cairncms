import { BaseException } from '@cairncms/exceptions';
import type { Accountability } from '@cairncms/types';
import { performance } from 'node:perf_hooks';
import env from '../../env.js';
import type { ConfigPostCommitPhase } from '../../exceptions/config-post-commit-failed.js';
import type { SchemaPostCommitPhase } from '../../exceptions/schema-post-commit-failed.js';
import logger from '../../logger.js';
import { CONFIG_KINDS, type ConfigKind } from '../../types/config.js';
import type { SchemaPersistedState } from '../../types/index.js';
import { CONFIG_APPLY_ORIGIN } from '../config-contract.js';
import { isValidUuid } from '../is-valid-uuid.js';
import { safeLogFragment } from '../safe-log-fragment.js';

export const CONFIG_RUN_EVENT = 'config.run.finished';

export const CONFIG_RUN_MESSAGE = 'Config run finished';

export const CONFIG_RUN_ID_HEADER = 'X-Config-Run-Id';

export const UNEXPECTED_ERROR_CODE = 'UNEXPECTED';

const RUN_RECORD_ERROR_CODE_LIST = [
	'CONFIG_INVALID',
	'CONFIG_IDENTITY_CONFLICT',
	'CONFIG_UNSUPPORTED_VERSION',
	'CONFIG_PLACEHOLDER_UNRESOLVED',
	'CONFIG_PROTECTED_RECORD',
	'CONFIG_FOLDER_IN_USE',
	'CONFIG_SCHEMA_SOURCE',
	'DESTRUCTIVE_CHANGES_REQUIRED',
	'CONFIG_STATE_CHANGED',
	'CONFIG_READ_FAILED',
	'CONFIG_APPLY_FAILED',
	'CONFIG_POST_COMMIT_FAILED',
	'CONFIG_APPLY_SCOPE_MISMATCH',
	'ADMIN_MUTATION_UNVERIFIED_TRANSACTION',
	'CONCURRENCY_CONFLICT',
	'SCHEMA_STATE_CHANGED',
	'SCHEMA_APPLY_FAILED',
	'SCHEMA_POST_COMMIT_FAILED',
] as const;

export const RUN_RECORD_ERROR_CODES: ReadonlySet<string> = new Set(RUN_RECORD_ERROR_CODE_LIST);

export type ConfigRunErrorCode = (typeof RUN_RECORD_ERROR_CODE_LIST)[number] | typeof UNEXPECTED_ERROR_CODE;

export function normalizeErrorCode(code: unknown): ConfigRunErrorCode {
	return typeof code === 'string' && RUN_RECORD_ERROR_CODES.has(code)
		? (code as ConfigRunErrorCode)
		: UNEXPECTED_ERROR_CODE;
}

export type ConfigRunSource = 'cli' | 'http';

export type ConfigRunSuccessResult = 'no_changes' | 'planned' | 'discarded' | 'applied';

export type ConfigRunFailureResult = 'refused' | 'invalid' | 'state_changed' | 'post_apply_failed' | 'failed';

export type ConfigRunResult = ConfigRunSuccessResult | ConfigRunFailureResult;

export type ConfigRunCaller =
	| { kind: 'system'; origin: typeof CONFIG_APPLY_ORIGIN }
	| { kind: 'user'; user: string; role: string }
	| { kind: 'request' };

export type ConfigRunChanges = { create: number; update: number; delete: number };

export type ConfigStepStatus = 'not_run' | 'skipped' | 'committed' | 'rolled_back' | 'failed' | 'unknown';

export type ConfigRunSteps = { folders: ConfigStepStatus; schema: ConfigStepStatus; configuration: ConfigStepStatus };

export type ConfigStepFailureDetail =
	| { persisted: SchemaPersistedState | 'unknown'; foreignKeysRestored?: false }
	| { phase: SchemaPostCommitPhase | ConfigPostCommitPhase };

export type ConfigRunStepFailure = { step: keyof ConfigRunSteps; detail?: ConfigStepFailureDetail };

export type ConfigRunFinished =
	| { result: ConfigRunSuccessResult; steps?: ConfigRunSteps }
	| {
			result: ConfigRunFailureResult;
			errorCode: ConfigRunErrorCode;
			steps?: ConfigRunSteps;
			failure?: ConfigRunStepFailure;
	  };

export type ConfigRunRecord = {
	event: typeof CONFIG_RUN_EVENT;
	runId?: string;
	source: ConfigRunSource;
	caller: ConfigRunCaller;
	userAgent?: string;
	dryRun: boolean;
	destructive: boolean;
	manifestVersion: number;
	managedKinds: ConfigKind[];
	changes?: ConfigRunChanges;
	result: ConfigRunResult;
	errorCode?: ConfigRunErrorCode;
	steps?: ConfigRunSteps;
	failure?: ConfigRunStepFailure;
	durationMs: number;
};

export type EmitPolicy = 'always' | 'raw-only';

export type ConfigRunStart = {
	source: ConfigRunSource;
	caller: ConfigRunCaller;
	userAgent?: string | undefined;
	runId?: string | undefined;
	dryRun: boolean;
	destructive: boolean;
	manifestVersion: number;
	managedKinds: readonly ConfigKind[];
	emit: EmitPolicy;
};

export type ConfigRun = {
	planned(summary: ConfigRunChanges): void;
	/** Records the approved per-step outcome for the run record, from the caller's own computed values. */
	outcome(steps: ConfigRunSteps, failure?: ConfigRunStepFailure): void;
};

export function systemCaller(): ConfigRunCaller {
	return { kind: 'system', origin: CONFIG_APPLY_ORIGIN };
}

export function normalizeCaller(caller: unknown): ConfigRunCaller {
	if (typeof caller !== 'object' || caller === null) return { kind: 'request' };

	const candidate = caller as { kind?: unknown; origin?: unknown; user?: unknown; role?: unknown };

	if (candidate.kind === 'system' && candidate.origin === CONFIG_APPLY_ORIGIN) return systemCaller();

	if (
		candidate.kind === 'user' &&
		typeof candidate.user === 'string' &&
		isValidUuid(candidate.user) &&
		typeof candidate.role === 'string' &&
		isValidUuid(candidate.role)
	) {
		return { kind: 'user', user: candidate.user, role: candidate.role };
	}

	return { kind: 'request' };
}

export function callerFromAccountability(accountability: Accountability | null | undefined): ConfigRunCaller {
	return normalizeCaller({ kind: 'user', user: accountability?.user, role: accountability?.role });
}

export function userAgentFrom(header: unknown): string | undefined {
	if (typeof header !== 'string' || header.length === 0) return undefined;

	return safeLogFragment(header);
}

function normalizeRunId(runId: unknown): string | undefined {
	return typeof runId === 'string' && isValidUuid(runId) ? runId : undefined;
}

function normalizeManagedKinds(kinds: unknown): ConfigKind[] {
	if (!Array.isArray(kinds)) return [];

	return kinds.filter((kind): kind is ConfigKind => (CONFIG_KINDS as readonly unknown[]).includes(kind));
}

export function classifyConfigError(err: unknown): {
	result: ConfigRunFailureResult;
	errorCode: ConfigRunErrorCode;
} {
	const thrown = Array.isArray(err) ? err[0] : err;

	if (!(thrown instanceof BaseException)) return { result: 'failed', errorCode: UNEXPECTED_ERROR_CODE };

	const errorCode = normalizeErrorCode(thrown.code);

	switch (errorCode) {
		case 'CONFIG_INVALID':
		case 'CONFIG_IDENTITY_CONFLICT':
			return { result: 'invalid', errorCode };
		case 'CONFIG_PROTECTED_RECORD':
		case 'CONFIG_FOLDER_IN_USE':
		case 'CONFIG_SCHEMA_SOURCE':
		case 'DESTRUCTIVE_CHANGES_REQUIRED':
			return { result: 'refused', errorCode };
		case 'CONFIG_STATE_CHANGED':
		case 'SCHEMA_STATE_CHANGED':
			return { result: 'state_changed', errorCode };
		case 'CONFIG_POST_COMMIT_FAILED':
		case 'SCHEMA_POST_COMMIT_FAILED':
			return { result: 'post_apply_failed', errorCode };
		default:
			return { result: 'failed', errorCode };
	}
}

export function shouldEmit(policy: EmitPolicy): boolean {
	return policy === 'always' || env['LOG_STYLE'] === 'raw';
}

export function emitConfigRunRecord(record: ConfigRunRecord): void {
	try {
		logger.info(record, CONFIG_RUN_MESSAGE);
	} catch {
		// A lost record must never change the outcome of the run it describes.
	}
}

/**
 * Attaches an approved per-step outcome to a thrown error for transport. The error keeps its type, code, status, and
 * detail and reaches the error middleware unchanged, which surfaces the outcome to the admin caller for an ordinary
 * error as well as a BaseException. The record is written separately through run.outcome, never read back from here.
 */
export function attachRunOutcome(error: unknown, steps: ConfigRunSteps, failure?: ConfigRunStepFailure): unknown {
	const thrown = Array.isArray(error) ? error[0] : error;

	if (typeof thrown === 'object' && thrown !== null) {
		const target = thrown as { extensions?: Record<string, unknown> };
		target.extensions = { ...target.extensions, steps, ...(failure !== undefined && { failure }) };
	}

	return error;
}

export async function withConfigRun<T extends ConfigRunFinished>(
	start: ConfigRunStart,
	body: (run: ConfigRun) => Promise<T>
): Promise<T> {
	const startedAt = performance.now();
	let changes: ConfigRunChanges | undefined;
	let recordedSteps: ConfigRunSteps | undefined;
	let recordedFailure: ConfigRunStepFailure | undefined;

	const run: ConfigRun = {
		planned(summary) {
			changes = { create: summary.create, update: summary.update, delete: summary.delete };
		},
		outcome(steps, failure) {
			recordedSteps = steps;
			recordedFailure = failure;
		},
	};

	const finish = (finished: ConfigRunFinished): void => {
		if (!shouldEmit(start.emit)) return;

		const runId = normalizeRunId(start.runId);
		const userAgent = userAgentFrom(start.userAgent);

		const steps = recordedSteps ?? finished.steps;
		const failure = recordedFailure ?? ('failure' in finished ? finished.failure : undefined);

		const record: ConfigRunRecord = {
			event: CONFIG_RUN_EVENT,
			...(runId !== undefined ? { runId } : {}),
			source: start.source === 'http' ? 'http' : 'cli',
			caller: normalizeCaller(start.caller),
			...(userAgent !== undefined ? { userAgent } : {}),
			dryRun: start.dryRun === true,
			destructive: start.destructive === true,
			manifestVersion: start.manifestVersion,
			managedKinds: normalizeManagedKinds(start.managedKinds),
			...(changes !== undefined ? { changes } : {}),
			result: finished.result,
			...('errorCode' in finished ? { errorCode: normalizeErrorCode(finished.errorCode) } : {}),
			...(steps !== undefined ? { steps } : {}),
			...(failure !== undefined ? { failure } : {}),
			durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
		};

		emitConfigRunRecord(record);
	};

	let finished: T;

	try {
		finished = await body(run);
	} catch (err) {
		finish(classifyConfigError(err));
		throw err;
	}

	finish(finished);

	return finished;
}
