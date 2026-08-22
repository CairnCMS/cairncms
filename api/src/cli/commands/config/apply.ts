import inquirer from 'inquirer';
import type { Knex } from 'knex';
import getDatabase, { hasDatabaseConnection, isInstalled } from '../../../database/index.js';
import logger from '../../../logger.js';
import { configFailureExitCode } from './exit-code.js';
import { applyConfigPlan, planHasDeletions } from '../../../utils/apply-config-plan.js';
import { computeConfigPlan, validateConfigPlan } from '../../../utils/compute-config-plan.js';
import { enrichConfigPlan } from '../../../utils/enrich-config-plan.js';
import { CONFIG_APPLY_ORIGIN } from '../../../utils/config-contract.js';
import { readCurrentConfig } from '../../../utils/get-config-snapshot.js';
import { getSchema } from '../../../utils/get-schema.js';
import { getSystemAccountability } from '../../../utils/get-system-accountability.js';
import { readConfigDirectory } from '../../../utils/read-config-directory.js';
import { serializeConfigPlan } from '../../../utils/serialize-config-plan.js';
import { validateDesiredConfig } from '../../../utils/validate-desired-config.js';
import type { CairnConfig, ConfigPlan, SerializedConfigPlan } from '../../../types/config.js';
import { confirmPrompt } from '../../presentation.js';
import { renderConfigPlan, renderRefusal, renderWarnings } from './render-config-plan.js';

function isPlanEmpty(plan: ConfigPlan): boolean {
	if (plan.roles.create.length > 0) return false;
	if (plan.roles.update.length > 0) return false;
	if (plan.roles.delete.length > 0) return false;
	if (plan.permissions.create.length > 0) return false;
	if (plan.permissions.update.length > 0) return false;
	if (plan.permissions.delete.length > 0) return false;

	return true;
}

async function serializePlan(plan: ConfigPlan, desired: CairnConfig, database: Knex): Promise<SerializedConfigPlan> {
	const schema = await getSchema({ database, bypassCache: true });
	const enrichment = await enrichConfigPlan(plan, desired, { schema, database });

	return serializeConfigPlan(plan, { enrichment, manifestVersion: desired.manifest.version });
}

export async function configApply(
	configPath: string,
	options?: { yes: boolean; dryRun: boolean; destructive: boolean; format: string }
): Promise<void> {
	const dryRun = options?.dryRun === true;
	const destructive = options?.destructive === true;
	const format = options?.format ?? 'human';

	if (format === 'json' && !dryRun) {
		logger.error('JSON output is only available with --dry-run.');
		process.exit(2);
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

		const { config: current, currentRoleKeys } = await readCurrentConfig({
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

		const currentRoles = new Map(current.roles.map((r) => [r.key, { admin_access: r.admin_access }]));

		const planFailures = validateConfigPlan(plan, desired, { currentRoles });

		if (planFailures.length > 0) {
			for (const failure of planFailures) {
				logger.error(failure.message);
			}

			database.destroy();
			process.exit(2);
		}

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

		if (!destructive && planHasDeletions(plan)) {
			logger.info(renderConfigPlan(serialized));
			logger.error(renderRefusal(serialized));
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
