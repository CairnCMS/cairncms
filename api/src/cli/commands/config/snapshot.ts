import inquirer from 'inquirer';
import getDatabase, { hasDatabaseConnection, isInstalled } from '../../../database/index.js';
import logger from '../../../logger.js';
import { configFailureExitCode } from './exit-code.js';
import { readContainedDirectory, resolveConfigRoot } from '../../../utils/config-path-safety.js';
import { readCurrentConfig } from '../../../utils/get-config-snapshot.js';
import { readOptionalConfigManifest } from '../../../utils/read-config-directory.js';
import { replaceControlCharacters } from '../../../utils/safe-log-fragment.js';
import { CONFIG_KINDS } from '../../../types/config.js';
import { writeConfigDirectory } from '../../../utils/write-config-directory.js';

export async function configSnapshot(targetPath: string, options?: { yes: boolean }): Promise<void> {
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
		const resolved = await resolveConfigRoot(targetPath, 'write');
		const existing = await readContainedDirectory(resolved, resolved);
		const dirNotEmpty = (existing ?? []).length > 0;

		if (dirNotEmpty && options?.yes !== true) {
			const { overwrite } = await inquirer.prompt([
				{
					type: 'confirm',
					name: 'overwrite',
					message: `Directory "${resolved}" is not empty. Overwrite?`,
				},
			]);

			if (overwrite === false) {
				database.destroy();
				process.exit(0);
			}
		}

		const declared = await readOptionalConfigManifest(resolved);
		const resources = declared?.resources ?? CONFIG_KINDS;

		const { config } = await readCurrentConfig({ database, resources });

		await writeConfigDirectory(config, resolved);

		const where = replaceControlCharacters(resolved);

		for (const kind of CONFIG_KINDS) {
			if (!config.manifest.resources.includes(kind)) {
				logger.info(`Leaving ${kind} unmanaged: the manifest in ${where} does not declare it.`);
			}
		}

		logger.info(
			`Snapshot: ${config.roles.length} role(s), ${config.permissions.length} permission set(s) written to ${where}`
		);

		database.destroy();
		process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(configFailureExitCode(err));
	}
}
