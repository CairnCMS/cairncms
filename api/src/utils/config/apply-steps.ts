import { BaseException } from '@cairncms/exceptions';
import type { Knex } from 'knex';
import { CONFIG_POST_COMMIT_PHASES, type ConfigPostCommitPhase } from '../../exceptions/config-post-commit-failed.js';
import { SCHEMA_POST_COMMIT_PHASES, type SchemaPostCommitPhase } from '../../exceptions/schema-post-commit-failed.js';
import type {
	ApplyResult,
	CairnConfig,
	ConfigApplySecurityContext,
	ConfigKind,
	ConfigSchemaCollection,
} from '../../types/config.js';
import {
	SCHEMA_CHANGE_OUTCOMES,
	SCHEMA_OPERATIONS,
	type SchemaChangeOutcome,
	type SchemaOperation,
	type SchemaPersistedCollection,
	type SchemaPersistedField,
	type SchemaPersistedRelation,
	type SchemaPersistedState,
	type SnapshotDiff,
	type SnapshotField,
} from '../../types/index.js';
import { applyConfigPlan } from '../apply-config-plan.js';
import { applyDiff } from '../apply-diff.js';
import { computeConfigPlan } from '../compute-config-plan.js';
import { buildFolderPreparationPlan } from '../folder-preparation.js';
import { readFolderKeys, referencedFolderKeys } from '../folder-references.js';
import { readCurrentConfig, type ConfigSchemaCapture } from '../get-config-snapshot.js';
import { getSchema } from '../get-schema.js';
import { buildExtensionDeclarationSnapshot, desiredExtensionSubjects } from './handlers/extension-settings.js';
import { computeSchemaDiff } from './handlers/schema.js';
import { isPlanEmpty } from './plan-folds.js';
import type { ConfigRunStepFailure, ConfigRunSteps, ConfigStepFailureDetail, ConfigStepStatus } from './run-record.js';

export type SchemaApplicability = ConfigSchemaCapture & { diff: SnapshotDiff };

export type WholeRunInputs = {
	schemaFields: SnapshotField[];
	availableFolderKeys: Map<string, string>;
	preparationFolderKeys: Set<string>;
	/** The executable schema diff with the read it was computed from, absent when schema is unmanaged. */
	schemaApplicability: SchemaApplicability | undefined;
};

/** Expects the normalized desired tree and the current schema, with its stored fields and capture, from one read. */
export async function computeWholeRunInputs(
	desired: CairnConfig,
	currentSchema: ConfigSchemaCollection[],
	schemaRead: { storedFields: SnapshotField[] | undefined; capture: ConfigSchemaCapture | undefined },
	database: Knex
): Promise<WholeRunInputs> {
	if (!desired.manifest.resources.includes('schema')) {
		return {
			schemaFields: [],
			availableFolderKeys: new Map(),
			preparationFolderKeys: new Set(),
			schemaApplicability: undefined,
		};
	}

	if (schemaRead.capture === undefined) {
		throw new Error('Schema validation requires the retained current schema read.');
	}

	const { diff, desiredSnapshot } = computeSchemaDiff(currentSchema, desired.schema, schemaRead.storedFields);
	const schemaFields = desiredSnapshot.fields;

	const { folderIdByKey } = await readFolderKeys(database);
	const availableFolderKeys = new Map(folderIdByKey);

	for (const folder of desired.folders) {
		if (!availableFolderKeys.has(folder.key)) availableFolderKeys.set(folder.key, folder.key);
	}

	const prepPlan = buildFolderPreparationPlan({
		referencedKeys: referencedFolderKeys(schemaFields),
		declaredFolders: desired.folders,
		currentFolderKeys: new Set(folderIdByKey.keys()),
	});

	return {
		schemaFields,
		availableFolderKeys,
		preparationFolderKeys: new Set(prepPlan.folders.create.map((f) => f.key)),
		schemaApplicability: { ...schemaRead.capture, diff },
	};
}

export async function applySchemaStep(options: {
	diff: SnapshotDiff;
	expectedHash: string;
	database: Knex;
}): Promise<void> {
	// The hash comes from the same read the diff is computed against, so applyDiff's recheck refuses a schema edit
	// committed between that read and its transaction.
	await applyDiff(options.diff, { database: options.database, expectedHash: options.expectedHash });
}

/** Reads the target again, because the preceding schema step can change it, before planning the non-schema kinds. */
export async function applyConfigurationStep(
	desired: CairnConfig,
	configResources: ConfigKind[],
	database: Knex,
	destructive: boolean,
	context: ConfigApplySecurityContext
): Promise<ApplyResult | undefined> {
	const extensionSettingsManaged = configResources.includes('extension-settings');
	const schema = extensionSettingsManaged ? await getSchema({ database, bypassCache: true }) : undefined;
	const extensionDeclarations = extensionSettingsManaged ? await buildExtensionDeclarationSnapshot() : undefined;

	const extensionSettingsSubjects = extensionSettingsManaged
		? desiredExtensionSubjects(desired['extension-settings'])
		: undefined;

	const { config: current, stateToken } = await readCurrentConfig({
		database,
		...(schema !== undefined && { schema }),
		resources: configResources,
		...(extensionSettingsSubjects !== undefined && { extensionSettingsSubjects }),
		...(extensionDeclarations !== undefined && { extensionDeclarations }),
	});

	const configDesired: CairnConfig = { ...desired, manifest: { ...desired.manifest, resources: configResources } };

	const plan = computeConfigPlan(current, configDesired, {
		...(extensionDeclarations !== undefined && { extensionDeclarations }),
	});

	if (isPlanEmpty(plan)) return undefined;

	return applyConfigPlan(plan, {
		database,
		destructive,
		context,
		expectedStateToken: stateToken,
		...(extensionDeclarations !== undefined && { extensionDeclarations }),
	});
}

/** Maps a failed step's error to its persisted-state status, so the run outcome says what the target holds. */
export function failureStatus(err: unknown): ConfigStepStatus {
	const thrown = Array.isArray(err) ? err[0] : err;
	const code = thrown instanceof BaseException ? thrown.code : undefined;

	if (code === 'SCHEMA_POST_COMMIT_FAILED' || code === 'CONFIG_POST_COMMIT_FAILED') return 'committed';

	if (code === 'SCHEMA_APPLY_FAILED') {
		return thrown instanceof BaseException && thrown.extensions['persisted'] === 'unknown' ? 'unknown' : 'failed';
	}

	if (code === 'CONFIG_APPLY_FAILED' || code === 'SCHEMA_STATE_CHANGED' || code === 'CONFIG_STATE_CHANGED') {
		return 'rolled_back';
	}

	return 'failed';
}

const POST_COMMIT_PHASES = new Set<string>([...SCHEMA_POST_COMMIT_PHASES, ...CONFIG_POST_COMMIT_PHASES]);
const SCHEMA_OPERATION_SET = new Set<string>(SCHEMA_OPERATIONS);
const SCHEMA_OUTCOME_SET = new Set<string>(SCHEMA_CHANGE_OUTCOMES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function outcomeOf(value: unknown): SchemaChangeOutcome {
	return typeof value === 'string' && SCHEMA_OUTCOME_SET.has(value) ? (value as SchemaChangeOutcome) : 'unknown';
}

/** Rebuilds a persisted-state entry from its known fields only, dropping an entry whose identity or operation is unsound. */
function projectEntries<Entry>(
	value: unknown,
	project: (entry: Record<string, unknown>) => Entry | undefined
): Entry[] {
	if (!Array.isArray(value)) return [];

	const projected: Entry[] = [];

	for (const entry of value) {
		if (!isRecord(entry)) continue;
		if (typeof entry['operation'] !== 'string' || !SCHEMA_OPERATION_SET.has(entry['operation'])) continue;

		const result = project(entry);
		if (result !== undefined) projected.push(result);
	}

	return projected;
}

/** Projects the reported persisted state to its declared shape, so an unrecognized or malformed value cannot be logged. */
function projectPersistedState(value: unknown): SchemaPersistedState | 'unknown' {
	if (!isRecord(value)) return 'unknown';

	return {
		collections: projectEntries<SchemaPersistedCollection>(value['collections'], (entry) =>
			typeof entry['collection'] === 'string'
				? {
						collection: entry['collection'],
						operation: entry['operation'] as SchemaOperation,
						table: outcomeOf(entry['table']),
						metadata: outcomeOf(entry['metadata']),
				  }
				: undefined
		),
		fields: projectEntries<SchemaPersistedField>(value['fields'], (entry) =>
			typeof entry['collection'] === 'string' && typeof entry['field'] === 'string'
				? {
						collection: entry['collection'],
						field: entry['field'],
						operation: entry['operation'] as SchemaOperation,
						column: outcomeOf(entry['column']),
						metadata: outcomeOf(entry['metadata']),
				  }
				: undefined
		),
		relations: projectEntries<SchemaPersistedRelation>(value['relations'], (entry) =>
			typeof entry['collection'] === 'string' && typeof entry['field'] === 'string'
				? {
						collection: entry['collection'],
						field: entry['field'],
						operation: entry['operation'] as SchemaOperation,
						foreignKey: 'unknown',
						metadata: outcomeOf(entry['metadata']),
				  }
				: undefined
		),
	};
}

/**
 * Extracts only the persisted-state and maintenance-phase fields of the exceptions that carry them, validating each
 * against its declared shape so the run record never relays an unrelated, malformed, or unsanitized error payload.
 */
export function failureDetail(err: unknown): ConfigStepFailureDetail | undefined {
	const thrown = Array.isArray(err) ? err[0] : err;

	if (!(thrown instanceof BaseException)) return undefined;

	if (thrown.code === 'SCHEMA_APPLY_FAILED') {
		const persisted = thrown.extensions['persisted'];

		return {
			persisted: persisted === 'unknown' ? 'unknown' : projectPersistedState(persisted),
			...(thrown.extensions['foreignKeysRestored'] === false && { foreignKeysRestored: false }),
		};
	}

	if (thrown.code === 'SCHEMA_POST_COMMIT_FAILED' || thrown.code === 'CONFIG_POST_COMMIT_FAILED') {
		const phase = thrown.extensions['phase'];

		if (typeof phase === 'string' && POST_COMMIT_PHASES.has(phase)) {
			return { phase: phase as SchemaPostCommitPhase | ConfigPostCommitPhase };
		}
	}

	return undefined;
}

export function stepFailure(step: keyof ConfigRunSteps, err: unknown): ConfigRunStepFailure {
	const detail = failureDetail(err);

	return detail !== undefined ? { step, detail } : { step };
}
