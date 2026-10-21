import { BaseException } from '@cairncms/exceptions';
import {
	CONFIG_POST_COMMIT_PHASES,
	type ConfigPostCommitPhase,
} from '../../../exceptions/config-post-commit-failed.js';
import {
	SCHEMA_POST_COMMIT_PHASES,
	type SchemaPostCommitPhase,
} from '../../../exceptions/schema-post-commit-failed.js';
import inquirer from 'inquirer';
import type { Knex } from 'knex';
import getDatabase, { getDatabaseClient, hasDatabaseConnection, isInstalled } from '../../../database/index.js';
import logger from '../../../logger.js';
import { configFailureExitCode } from './exit-code.js';
import { applyConfigPlan } from '../../../utils/apply-config-plan.js';
import { computeConfigPlan } from '../../../utils/compute-config-plan.js';
import {
	buildExtensionDeclarationSnapshot,
	desiredExtensionSubjects,
} from '../../../utils/config/handlers/extension-settings.js';
import { isPlanEmpty, planSummary } from '../../../utils/config/plan-folds.js';
import {
	classifyConfigError,
	systemCaller,
	withConfigRun,
	type ConfigRun,
	type ConfigRunFinished,
	type ConfigRunStepFailure,
	type ConfigRunSteps,
	type ConfigStepFailureDetail,
	type ConfigStepStatus,
} from '../../../utils/config/run-record.js';
import { enrichConfigPlan } from '../../../utils/enrich-config-plan.js';
import { CONFIG_APPLY_ORIGIN } from '../../../utils/config-contract.js';
import { readCurrentConfig } from '../../../utils/get-config-snapshot.js';
import { getSchema } from '../../../utils/get-schema.js';
import { getSystemAccountability } from '../../../utils/get-system-accountability.js';
import { isValidUuid } from '../../../utils/is-valid-uuid.js';
import { readConfigDirectory } from '../../../utils/read-config-directory.js';
import { serializeConfigPlan } from '../../../utils/serialize-config-plan.js';
import { validateDesiredConfig } from '../../../utils/validate-desired-config.js';
import { serializeToWire } from '../../../utils/config/wire.js';
import { applyFolderPreparation } from '../../../utils/apply-folder-preparation.js';
import { applyDiff } from '../../../utils/apply-diff.js';
import { computeSchemaDiff, reconcileDesiredSchemaSnapshot } from '../../../utils/config/handlers/schema.js';
import { buildFolderPreparationPlan } from '../../../utils/folder-preparation.js';
import { readFolderKeys, referencedFolderKeys } from '../../../utils/folder-references.js';
import { assertMutationAuthorized, assertRunValid } from '../../../utils/config/run-preflight.js';
import { version as currentRelease } from '../../../utils/package.js';
import type { SchemaOverview } from '@cairncms/types';
import {
	SCHEMA_CHANGE_OUTCOMES,
	SCHEMA_OPERATIONS,
	type SchemaChangeOutcome,
	type SchemaOperation,
	type SchemaPersistedCollection,
	type SchemaPersistedField,
	type SchemaPersistedRelation,
	type SchemaPersistedState,
	type SnapshotField,
} from '../../../types/index.js';
import type {
	ApplyResult,
	CairnConfig,
	ConfigApplySecurityContext,
	ConfigKind,
	ConfigPlan,
	SerializedConfigPlan,
} from '../../../types/config.js';
import { confirmPrompt } from '../../presentation.js';
import { isHttpTarget, parseOperatorRemoteTarget } from './operator-remote-target.js';
import { createOperatorRemoteTransport } from './operator-remote-transport.js';
import {
	applyRemote,
	assertServerSupportsRemoteConfig,
	fetchServerVersion,
	type RemoteSession,
} from './remote-client.js';
import { resolveRemoteToken } from './remote-token.js';
import { readFileSync } from 'node:fs';
import { renderConfigPlan, renderNoChanges, renderResultSummary, renderStepOutcome } from './render-config-plan.js';

async function serializePlan(
	plan: ConfigPlan,
	desired: CairnConfig,
	database: Knex,
	schema: SchemaOverview | undefined,
	preparationFolderKeys?: ReadonlySet<string>
): Promise<SerializedConfigPlan> {
	const resolvedSchema = schema ?? (await getSchema({ database, bypassCache: true }));
	const enrichment = await enrichConfigPlan(plan, desired, { schema: resolvedSchema, database });

	return serializeConfigPlan(plan, {
		enrichment,
		manifestVersion: desired.manifest.version,
		...(preparationFolderKeys !== undefined && { preparationFolderKeys }),
	});
}

export async function configApply(
	configPath: string,
	options?: {
		yes: boolean;
		dryRun: boolean;
		destructive: boolean;
		forceSchema?: boolean;
		format: string;
		url?: string;
		tokenStdin?: boolean;
	}
): Promise<void> {
	const dryRun = options?.dryRun === true;
	const destructive = options?.destructive === true;
	const forceSchema = options?.forceSchema === true;
	const format = options?.format ?? 'human';

	if (format === 'json' && !dryRun) {
		logger.error('JSON output is only available with --dry-run.');
		process.exit(2);
	}

	if (options?.url !== undefined) {
		return configApplyRemote(configPath, options.url, { dryRun, destructive, format, options });
	}

	const database = getDatabase();

	if ((await hasDatabaseConnection(database)) === false) {
		logger.error(`Can't connect to the database.`);
		database.destroy();
		process.exit(3);
	}

	if ((await isInstalled()) === false) {
		logger.error(`System tables are not installed on this database. Please run "cairncms bootstrap" first.`);
		database.destroy();
		process.exit(3);
	}

	const { exitCode } = await runLocalApply(configPath, database, {
		dryRun,
		destructive,
		forceSchema,
		format,
		yes: options?.yes === true,
	});

	database.destroy();
	process.exit(exitCode);
}

type ExitCode = 0 | 1 | 2 | 3;

type LocalApplyOptions = { dryRun: boolean; destructive: boolean; forceSchema: boolean; format: string; yes: boolean };

type LocalApplyOutcome = ConfigRunFinished & { exitCode: ExitCode };

async function runLocalApply(
	configPath: string,
	database: Knex,
	opts: LocalApplyOptions
): Promise<{ exitCode: ExitCode }> {
	let desired: CairnConfig;

	try {
		desired = await readConfigDirectory(configPath, {
			notice: (message) => logger.warn(message),
		});
	} catch (err) {
		logger.error(err);
		return { exitCode: configFailureExitCode(err) };
	}

	return withConfigRun(
		{
			source: 'cli',
			caller: systemCaller(),
			dryRun: opts.dryRun,
			destructive: opts.destructive,
			manifestVersion: desired.manifest.version,
			managedKinds: desired.manifest.resources,
			emit: 'raw-only',
		},
		(run) => runLocalEngine(configPath, desired, database, opts, run)
	);
}

async function runLocalEngine(
	configPath: string,
	desired: CairnConfig,
	database: Knex,
	opts: LocalApplyOptions,
	run: ConfigRun
): Promise<LocalApplyOutcome> {
	const { dryRun, destructive, forceSchema, format, yes } = opts;

	let committedStep = false;
	let currentStep: keyof ConfigRunSteps | undefined;
	const steps: ConfigRunSteps = { folders: 'not_run', schema: 'not_run', configuration: 'not_run' };

	try {
		const extensionSettingsManaged = desired.manifest.resources.includes('extension-settings');
		const schema = extensionSettingsManaged ? await getSchema({ database, bypassCache: true }) : undefined;

		const extensionDeclarations = extensionSettingsManaged ? await buildExtensionDeclarationSnapshot() : undefined;

		const currentCollections = schema?.collections;

		const extensionSettingsSubjects = extensionSettingsManaged
			? desiredExtensionSubjects(desired['extension-settings'])
			: undefined;

		const {
			config: current,
			currentRoleKeys,
			currentFolderKeys,
			currentFolderParents,
			stateToken,
			schemaStoredFields,
			schemaKeyFormHash,
		} = await readCurrentConfig({
			database,
			...(schema !== undefined && { schema }),
			resources: desired.manifest.resources,
			...(extensionSettingsSubjects !== undefined && { extensionSettingsSubjects }),
			...(extensionDeclarations !== undefined && { extensionDeclarations }),
		});

		const documentErrors = validateDesiredConfig(serializeToWire(desired, desired.manifest.version), {
			label: configPath,
			references: 'current-state',
			currentRoleKeys,
			currentFolderKeys,
			currentFolderParents,
			...(extensionDeclarations !== undefined && { extensionDeclarations }),
			...(currentCollections !== undefined && { currentCollections }),
			...(schemaStoredFields !== undefined && {
				currentSchema: { records: current.schema, storedFields: schemaStoredFields },
			}),
		});

		if (documentErrors.length > 0) {
			for (const failure of documentErrors) {
				logger.error(failure.message);
			}

			return { result: 'invalid', errorCode: documentErrors[0]!.code, exitCode: 2 };
		}

		const plan = computeConfigPlan(current, desired, {
			...(extensionDeclarations !== undefined && { extensionDeclarations }),
			...(schemaStoredFields !== undefined && { currentSchemaStoredFields: schemaStoredFields }),
		});

		run.planned(planSummary(plan));

		const schemaManaged = desired.manifest.resources.includes('schema');

		let schemaFields: SnapshotField[] = [];
		let availableFolderKeys = new Map<string, string>();
		let preparationFolderKeys: ReadonlySet<string> | undefined;

		if (schemaManaged) {
			schemaFields = reconcileDesiredSchemaSnapshot(current.schema, desired.schema).desired.fields;

			const { folderIdByKey } = await readFolderKeys(database);
			availableFolderKeys = new Map(folderIdByKey);

			for (const folder of desired.folders) {
				if (!availableFolderKeys.has(folder.key)) availableFolderKeys.set(folder.key, folder.key);
			}

			const prepPlan = buildFolderPreparationPlan({
				referencedKeys: referencedFolderKeys(schemaFields),
				declaredFolders: desired.folders,
				currentFolderKeys: new Set(folderIdByKey.keys()),
			});

			preparationFolderKeys = new Set(prepPlan.folders.create.map((folder) => folder.key));
		}

		assertRunValid({
			manifest: desired.manifest,
			forceSchema,
			currentRelease,
			currentVendor: schemaManaged ? getDatabaseClient(database) : '',
			schemaFields,
			availableFolderKeys,
		});

		const empty = isPlanEmpty(plan);

		if (format === 'json') {
			process.stdout.write(
				JSON.stringify(await serializePlan(plan, desired, database, schema, preparationFolderKeys)) + '\n'
			);

			return { result: empty ? 'no_changes' : 'planned', exitCode: empty ? 0 : 1 };
		}

		if (empty) {
			if (desired.manifest.resources.includes('permissions')) {
				logger.info(renderNoChanges(await serializePlan(plan, desired, database, schema, preparationFolderKeys)));
			} else {
				logger.info(renderNoChanges());
			}

			return { result: 'no_changes', exitCode: 0 };
		}

		logger.info(renderConfigPlan(await serializePlan(plan, desired, database, schema, preparationFolderKeys)));

		if (dryRun) return { result: 'planned', exitCode: 1 };

		assertMutationAuthorized(plan, destructive);

		if (!yes) {
			const { proceed } = await inquirer.prompt([{ type: 'confirm', name: 'proceed', message: confirmPrompt }]);

			if (proceed === false) return { result: 'discarded', exitCode: 0 };
		}

		const context: ConfigApplySecurityContext = {
			mode: 'system',
			reason: 'local config apply',
			accountability: { ...getSystemAccountability(), origin: CONFIG_APPLY_ORIGIN },
		};

		if (!schemaManaged) {
			const result = await applyConfigPlan(plan, {
				database,
				destructive,
				context,
				expectedStateToken: stateToken,
				...(extensionDeclarations !== undefined && { extensionDeclarations }),
			});

			logger.info(renderResultSummary(result));
			return { result: 'applied', exitCode: 0 };
		}

		currentStep = 'folders';
		const created = await applyFolderPreparation(desired, current.schema, { context, database });
		steps.folders = created.length > 0 ? 'committed' : 'skipped';
		if (created.length > 0) committedStep = true;

		if (sliceHasChanges(plan.schema)) {
			currentStep = 'schema';
			const { diff } = computeSchemaDiff(current.schema, desired.schema, schemaStoredFields);
			// The hash comes from the same read the diff is computed against, so applyDiff's recheck refuses a
			// schema edit committed between that read and its transaction.
			await applyDiff(diff, { database, expectedHash: schemaKeyFormHash ?? '' });
			steps.schema = 'committed';
			committedStep = true;
		} else {
			steps.schema = 'skipped';
		}

		const configResources = desired.manifest.resources.filter((kind) => kind !== 'schema');

		if (configResources.length > 0) {
			currentStep = 'configuration';
			const result = await applyConfigurationStep(desired, configResources, database, destructive, context);
			steps.configuration = result !== undefined ? 'committed' : 'skipped';

			if (result !== undefined) {
				committedStep = true;
				logger.info(renderResultSummary(result));
			}
		} else {
			steps.configuration = 'skipped';
		}

		logger.info(renderStepOutcome(steps));
		return { result: 'applied', exitCode: 0, steps };
	} catch (err) {
		logger.error(err);
		const exitCode = committedStep ? 3 : configFailureExitCode(err);

		if (currentStep === undefined) return { ...classifyConfigError(err), exitCode };

		steps[currentStep] = failureStatus(err);
		logger.info(renderStepOutcome(steps));
		return { ...classifyConfigError(err), exitCode, steps, failure: stepFailure(currentStep, err) };
	}
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

function stepFailure(step: keyof ConfigRunSteps, err: unknown): ConfigRunStepFailure {
	const detail = failureDetail(err);

	return detail !== undefined ? { step, detail } : { step };
}

function sliceHasChanges(slice: { create: unknown[]; update: unknown[]; delete: unknown[] }): boolean {
	return slice.create.length > 0 || slice.update.length > 0 || slice.delete.length > 0;
}

async function applyConfigurationStep(
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

async function configApplyRemote(
	configPath: string,
	url: string,
	ctx: { dryRun: boolean; destructive: boolean; format: string; options: { yes?: boolean; tokenStdin?: boolean } }
): Promise<void> {
	const { dryRun, destructive, format } = ctx;

	if (!dryRun && ctx.options.yes !== true) {
		logger.error(
			'A remote mutating apply requires --yes; there is no interactive confirmation against a remote server.'
		);

		process.exit(2);
	}

	try {
		const target = parseOperatorRemoteTarget(url);

		const token = resolveRemoteToken({
			envToken: process.env['CAIRNCMS_TOKEN'],
			tokenFile: process.env['CAIRNCMS_TOKEN_FILE'],
			tokenStdin: ctx.options.tokenStdin === true,
			readStdin: () => readFileSync(0, 'utf8'),
		});

		if (isHttpTarget(target)) {
			logger.warn('The admin token will be sent over http:// without transport encryption. Prefer https://.');
		}

		const transport = await createOperatorRemoteTransport();
		const session: RemoteSession = { transport, target, token };

		assertServerSupportsRemoteConfig(await fetchServerVersion(session), session.token);

		const desired = await readConfigDirectory(configPath, { notice: (message) => logger.warn(message) });

		if (dryRun) {
			const { plan, runId } = await applyRemote(session, desired, { dryRun: true, destructive });
			const clean = plan.changes.length === 0 && plan.protections.length === 0;

			if (format === 'json') {
				process.stdout.write(`${JSON.stringify(plan)}\n`);
			} else if (clean) {
				logger.info(renderNoChanges(plan));
			} else {
				logger.info(renderConfigPlan(plan));
			}

			printRemoteRun(runId);
			process.exit(clean ? 0 : 1);
		}

		const { plan, result, runId } = await applyRemote(session, desired, { dryRun: false, destructive });

		if (plan.changes.length === 0) {
			logger.info(renderNoChanges(plan));
		} else {
			logger.info(renderConfigPlan(plan));
			logger.info(renderResultSummary(result));
		}

		printRemoteRun(runId);
		process.exit(0);
	} catch (err) {
		logger.error(err instanceof Error ? err.message : String(err));
		printRemoteRun((err as { runId?: unknown }).runId);

		const exitCode =
			typeof (err as { exitCode?: unknown }).exitCode === 'number'
				? (err as { exitCode: number }).exitCode
				: configFailureExitCode(err);

		process.exit(exitCode);
	}
}

function printRemoteRun(runId: unknown): void {
	if (typeof runId === 'string' && isValidUuid(runId)) logger.info(`Run ${runId}`);
}
