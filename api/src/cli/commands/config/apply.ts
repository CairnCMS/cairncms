import chalk from 'chalk';
import inquirer from 'inquirer';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import logger from '../../../logger.js';
import path from 'path';
import { applyConfigPlan } from '../../../utils/apply-config-plan.js';
import { computeConfigPlan, validateConfigPlan } from '../../../utils/compute-config-plan.js';
import { getConfigSnapshot } from '../../../utils/get-config-snapshot.js';
import { readConfigDirectory } from '../../../utils/read-config-directory.js';
import type { ConfigPlan } from '../../../types/config.js';

function formatPlanHuman(plan: ConfigPlan, destructive: boolean): string {
	const lines: string[] = [];

	if (plan.roles.create.length > 0) {
		lines.push(chalk.underline.bold('Roles:'));

		for (const role of plan.roles.create) {
			lines.push(`  ${chalk.green('Create')} ${role.key} (${role.name})`);
		}
	}

	if (plan.roles.update.length > 0) {
		if (lines.length === 0) lines.push(chalk.underline.bold('Roles:'));

		for (const { key, diff } of plan.roles.update) {
			const fields = Object.keys(diff).join(', ');
			lines.push(`  ${chalk.blue('Update')} ${key} (${fields})`);
		}
	}

	if (destructive && plan.roles.delete.length > 0) {
		if (lines.length === 0) lines.push(chalk.underline.bold('Roles:'));

		for (const key of plan.roles.delete) {
			lines.push(`  ${chalk.red('Delete')} ${key}`);
		}
	}

	const permCreates = plan.permissions.create.length;
	const permUpdates = plan.permissions.update.length;
	const permDeletes = destructive
		? plan.permissions.delete.filter((d) => !plan.roles.delete.includes(d.roleKey)).length
		: 0;

	if (permCreates > 0 || permUpdates > 0 || permDeletes > 0) {
		lines.push('');
		lines.push(chalk.underline.bold('Permissions:'));

		if (permCreates > 0) lines.push(`  ${chalk.green('Create')} ${permCreates} permission(s)`);
		if (permUpdates > 0) lines.push(`  ${chalk.blue('Update')} ${permUpdates} permission(s)`);
		if (permDeletes > 0) lines.push(`  ${chalk.red('Delete')} ${permDeletes} permission(s)`);
	}

	return lines.join('\n');
}

function isPlanEmpty(plan: ConfigPlan, destructive: boolean): boolean {
	if (plan.roles.create.length > 0) return false;
	if (plan.roles.update.length > 0) return false;
	if (plan.permissions.create.length > 0) return false;
	if (plan.permissions.update.length > 0) return false;

	if (destructive) {
		if (plan.roles.delete.length > 0) return false;

		const keptRoleDeletes = plan.permissions.delete.filter(
			(d) => !plan.roles.delete.includes(d.roleKey)
		).length;

		if (keptRoleDeletes > 0) return false;
	}

	return true;
}

export async function configApply(
	configPath: string,
	options?: { yes: boolean; dryRun: boolean; destructive: boolean; format: string }
): Promise<void> {
	const database = getDatabase();

	await validateDatabaseConnection(database);

	if ((await isInstalled()) === false) {
		logger.error(`Directus isn't installed on this database. Please run "directus bootstrap" first.`);
		database.destroy();
		process.exit(1);
	}

	try {
		const resolved = path.resolve(process.cwd(), configPath);
		const dryRun = options?.dryRun === true;
		const destructive = options?.destructive === true;
		const format = options?.format ?? 'human';

		const desired = await readConfigDirectory(resolved);
		const current = await getConfigSnapshot({ database });
		const plan = computeConfigPlan(current, desired);

		const currentRoles = new Map(
			current.roles.map((r) => [r.key, { admin_access: r.admin_access }])
		);

		const validation = validateConfigPlan(plan, desired, { currentRoles });

		if (validation.errors.length > 0) {
			for (const error of validation.errors) {
				logger.error(error);
			}

			database.destroy();
			process.exit(2);
		}

		if (isPlanEmpty(plan, destructive)) {
			if (format === 'json') {
				process.stdout.write(JSON.stringify({ changes: false, plan: null }) + '\n');
			} else {
				logger.info('No changes to apply.');
			}

			database.destroy();
			process.exit(0);
		}

		if (format === 'json') {
			const result = await applyConfigPlan(plan, { database, destructive, dryRun: true });
			process.stdout.write(JSON.stringify({ changes: true, plan: result }) + '\n');

			if (dryRun) {
				database.destroy();
				process.exit(1);
			}
		} else {
			const message = formatPlanHuman(plan, destructive);
			logger.info('Planned changes:\n\n' + message);

			if (dryRun) {
				database.destroy();
				process.exit(1);
			}
		}

		if (options?.yes !== true) {
			const { proceed } = await inquirer.prompt([
				{
					type: 'confirm',
					name: 'proceed',
					message: 'Apply these changes?',
				},
			]);

			if (proceed === false) {
				database.destroy();
				process.exit(0);
			}
		}

		const result = await applyConfigPlan(plan, { database, destructive });

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
		process.exit(1);
	}
}
