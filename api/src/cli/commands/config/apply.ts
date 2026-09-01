import inquirer from 'inquirer';
import type { Knex } from 'knex';
import getDatabase, { hasDatabaseConnection, isInstalled } from '../../../database/index.js';
import logger from '../../../logger.js';
import { configFailureExitCode } from './exit-code.js';
import { applyConfigPlan, planHasDeletions } from '../../../utils/apply-config-plan.js';
import { computeConfigPlan } from '../../../utils/compute-config-plan.js';
import { isPlanEmpty } from '../../../utils/config/plan-folds.js';
import { enrichConfigPlan } from '../../../utils/enrich-config-plan.js';
import { CONFIG_APPLY_ORIGIN } from '../../../utils/config-contract.js';
import { readCurrentConfig } from '../../../utils/get-config-snapshot.js';
import { getSchema } from '../../../utils/get-schema.js';
import { getSystemAccountability } from '../../../utils/get-system-accountability.js';
import { readConfigDirectory } from '../../../utils/read-config-directory.js';
import { serializeConfigPlan } from '../../../utils/serialize-config-plan.js';
import { validateDesiredConfig } from '../../../utils/validate-desired-config.js';
import type { ApplyResult, CairnConfig, ConfigPlan, SerializedConfigPlan } from '../../../types/config.js';
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
import { renderConfigPlan, renderDestructiveRefusal, renderWarnings } from './render-config-plan.js';

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

	try {
		const desired = await readConfigDirectory(configPath, {
			notice: (message) => logger.warn(message),
		});

		const {
			config: current,
			currentRoleKeys,
			stateToken,
		} = await readCurrentConfig({
			database,
			resources: desired.manifest.resources,
		});

		const documentErrors = validateDesiredConfig(desired, { label: configPath, currentRoleKeys });

		if (documentErrors.length > 0) {
			for (const failure of documentErrors) {
				logger.error(failure.message);
			}

			database.destroy();
			process.exit(2);
		}

		const plan = computeConfigPlan(current, desired);

		const empty = isPlanEmpty(plan);

		if (format === 'json') {
			process.stdout.write(JSON.stringify(await serializePlan(plan, desired, database)) + '\n');
			database.destroy();
			process.exit(empty ? 0 : 1);
		}

		if (empty) {
			if (desired.manifest.resources.includes('permissions')) {
				const warnings = renderWarnings(await serializePlan(plan, desired, database));
				logger.info(warnings ? `No changes to apply.\n\n${warnings}` : 'No changes to apply.');
			} else {
				logger.info('No changes to apply.');
			}

			database.destroy();
			process.exit(0);
		}

		const serialized = await serializePlan(plan, desired, database);

		if (dryRun) {
			logger.info(renderConfigPlan(serialized));
			database.destroy();
			process.exit(1);
		}

		if (plan.protections.length > 0) {
			logger.info(renderConfigPlan(serialized));
			database.destroy();
			process.exit(2);
		}

		if (!destructive && planHasDeletions(plan)) {
			logger.info(renderConfigPlan(serialized));
			logger.error(renderDestructiveRefusal(serialized));
			database.destroy();
			process.exit(2);
		}

		logger.info(renderConfigPlan(serialized));

		if (options?.yes !== true) {
			const { proceed } = await inquirer.prompt([
				{
					type: 'confirm',
					name: 'proceed',
					message: confirmPrompt,
				},
			]);

			if (proceed === false) {
				database.destroy();
				process.exit(0);
			}
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

		const parts: string[] = [];

		if (result.roles.created.length > 0) parts.push(`${result.roles.created.length} role(s) created`);
		if (result.roles.updated.length > 0) parts.push(`${result.roles.updated.length} role(s) updated`);
		if (result.roles.deleted.length > 0) parts.push(`${result.roles.deleted.length} role(s) deleted`);
		if (result.permissions.created > 0) parts.push(`${result.permissions.created} permission(s) created`);
		if (result.permissions.updated > 0) parts.push(`${result.permissions.updated} permission(s) updated`);
		if (result.permissions.deleted > 0) parts.push(`${result.permissions.deleted} permission(s) deleted`);

		logger.info(`Config applied: ${parts.join(', ')}`);

		database.destroy();
		process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(configFailureExitCode(err));
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
		const outcome = await applyRemote(session, desired, { dryRun, destructive });
		const plan = outcome.plan as SerializedConfigPlan;
		const clean = plan.changes.length === 0 && plan.protections.length === 0;

		if (format === 'json') {
			process.stdout.write(`${JSON.stringify(plan)}\n`);
			process.exit(clean ? 0 : 1);
		}

		if (dryRun) {
			if (clean) {
				const warnings = renderWarnings(plan);
				logger.info(warnings ? `No changes to apply.\n\n${warnings}` : 'No changes to apply.');
			} else {
				logger.info(renderConfigPlan(plan));
			}

			process.exit(clean ? 0 : 1);
		}

		logger.info(renderConfigPlan(plan));
		logger.info(remoteResultSummary(outcome.result as ApplyResult));
		process.exit(0);
	} catch (err) {
		logger.error(err instanceof Error ? err.message : String(err));

		const exitCode =
			typeof (err as { exitCode?: unknown }).exitCode === 'number'
				? (err as { exitCode: number }).exitCode
				: configFailureExitCode(err);

		process.exit(exitCode);
	}
}

function remoteResultSummary(result: ApplyResult): string {
	const parts: string[] = [];

	if (result.roles.created.length > 0) parts.push(`${result.roles.created.length} role(s) created`);
	if (result.roles.updated.length > 0) parts.push(`${result.roles.updated.length} role(s) updated`);
	if (result.roles.deleted.length > 0) parts.push(`${result.roles.deleted.length} role(s) deleted`);
	if (result.permissions.created > 0) parts.push(`${result.permissions.created} permission(s) created`);
	if (result.permissions.updated > 0) parts.push(`${result.permissions.updated} permission(s) updated`);
	if (result.permissions.deleted > 0) parts.push(`${result.permissions.deleted} permission(s) deleted`);

	return `Config applied: ${parts.join(', ')}`;
}
