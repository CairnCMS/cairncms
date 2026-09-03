import inquirer from 'inquirer';
import type { Knex } from 'knex';
import getDatabase, { hasDatabaseConnection, isInstalled } from '../../../database/index.js';
import logger from '../../../logger.js';
import { configFailureExitCode } from './exit-code.js';
import { applyConfigPlan, planHasDeletions } from '../../../utils/apply-config-plan.js';
import { computeConfigPlan } from '../../../utils/compute-config-plan.js';
import { isPlanEmpty, planSummary } from '../../../utils/config/plan-folds.js';
import {
	classifyConfigError,
	systemCaller,
	withConfigRun,
	type ConfigRun,
	type ConfigRunFinished,
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
import type { CairnConfig, ConfigPlan, SerializedConfigPlan } from '../../../types/config.js';
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
import {
	renderConfigPlan,
	renderDestructiveRefusal,
	renderWarnings,
	type RenderableResult,
} from './render-config-plan.js';

async function serializePlan(plan: ConfigPlan, desired: CairnConfig, database: Knex): Promise<SerializedConfigPlan> {
	const schema = await getSchema({ database, bypassCache: true });
	const enrichment = await enrichConfigPlan(plan, desired, { schema, database });

	return serializeConfigPlan(plan, { enrichment, manifestVersion: desired.manifest.version });
}

export async function configApply(
	configPath: string,
	options?: { yes: boolean; dryRun: boolean; destructive: boolean; format: string; url?: string; tokenStdin?: boolean }
): Promise<void> {
	const dryRun = options?.dryRun === true;
	const destructive = options?.destructive === true;
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
		format,
		yes: options?.yes === true,
	});

	database.destroy();
	process.exit(exitCode);
}

type ExitCode = 0 | 1 | 2 | 3;

type LocalApplyOptions = { dryRun: boolean; destructive: boolean; format: string; yes: boolean };

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
	const { dryRun, destructive, format, yes } = opts;

	try {
		const {
			config: current,
			currentRoleKeys,
			stateToken,
		} = await readCurrentConfig({
			database,
			resources: desired.manifest.resources,
		});

		const documentErrors = validateDesiredConfig(desired, {
			label: configPath,
			references: 'current-state',
			currentRoleKeys,
		});

		if (documentErrors.length > 0) {
			for (const failure of documentErrors) {
				logger.error(failure.message);
			}

			return { result: 'invalid', errorCode: documentErrors[0]!.code, exitCode: 2 };
		}

		const plan = computeConfigPlan(current, desired);

		const empty = isPlanEmpty(plan);

		run.planned(planSummary(plan));

		if (format === 'json') {
			process.stdout.write(JSON.stringify(await serializePlan(plan, desired, database)) + '\n');
			return { result: empty ? 'no_changes' : 'planned', exitCode: empty ? 0 : 1 };
		}

		if (empty) {
			if (desired.manifest.resources.includes('permissions')) {
				const warnings = renderWarnings(await serializePlan(plan, desired, database));
				logger.info(warnings ? `No changes to apply.\n\n${warnings}` : 'No changes to apply.');
			} else {
				logger.info('No changes to apply.');
			}

			return { result: 'no_changes', exitCode: 0 };
		}

		const serialized = await serializePlan(plan, desired, database);

		if (dryRun) {
			logger.info(renderConfigPlan(serialized));
			return { result: 'planned', exitCode: 1 };
		}

		if (plan.protections.length > 0) {
			logger.info(renderConfigPlan(serialized));
			return { result: 'refused', errorCode: 'CONFIG_PROTECTED_RECORD', exitCode: 2 };
		}

		if (!destructive && planHasDeletions(plan)) {
			logger.info(renderConfigPlan(serialized));
			logger.error(renderDestructiveRefusal(serialized));
			return { result: 'refused', errorCode: 'DESTRUCTIVE_CHANGES_REQUIRED', exitCode: 2 };
		}

		logger.info(renderConfigPlan(serialized));

		if (!yes) {
			const { proceed } = await inquirer.prompt([
				{
					type: 'confirm',
					name: 'proceed',
					message: confirmPrompt,
				},
			]);

			if (proceed === false) return { result: 'discarded', exitCode: 0 };
		}

		const result = await applyConfigPlan(plan, {
			database,
			destructive,
			context: {
				mode: 'system',
				reason: 'local config apply',
				accountability: { ...getSystemAccountability(), origin: CONFIG_APPLY_ORIGIN },
			},
			expectedStateToken: stateToken,
		});

		logger.info(applyResultSummary(result));

		return { result: 'applied', exitCode: 0 };
	} catch (err) {
		logger.error(err);
		return { ...classifyConfigError(err), exitCode: configFailureExitCode(err) };
	}
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
				const warnings = renderWarnings(plan);
				logger.info(warnings ? `No changes to apply.\n\n${warnings}` : 'No changes to apply.');
			} else {
				logger.info(renderConfigPlan(plan));
			}

			printRemoteRun(runId);
			process.exit(clean ? 0 : 1);
		}

		const { plan, result, runId } = await applyRemote(session, desired, { dryRun: false, destructive });

		logger.info(renderConfigPlan(plan));
		logger.info(applyResultSummary(result));

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

function applyResultSummary(result: RenderableResult): string {
	const parts: string[] = [];

	if (result.roles.created.length > 0) parts.push(`${result.roles.created.length} role(s) created`);
	if (result.roles.updated.length > 0) parts.push(`${result.roles.updated.length} role(s) updated`);
	if (result.roles.deleted.length > 0) parts.push(`${result.roles.deleted.length} role(s) deleted`);
	if (result.permissions.created > 0) parts.push(`${result.permissions.created} permission(s) created`);
	if (result.permissions.updated > 0) parts.push(`${result.permissions.updated} permission(s) updated`);
	if (result.permissions.deleted > 0) parts.push(`${result.permissions.deleted} permission(s) deleted`);

	return `Config applied: ${parts.join(', ')}`;
}
