import { promises as fs } from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import logger from '../../../logger.js';
import { getConfigSnapshot } from '../../../utils/get-config-snapshot.js';
import { writeConfigDirectory } from '../../../utils/write-config-directory.js';

export async function configSnapshot(targetPath: string, options?: { yes: boolean }): Promise<void> {
	const database = getDatabase();

	await validateDatabaseConnection(database);

	if ((await isInstalled()) === false) {
		logger.error(`System tables are not installed on this database. Please run "cairncms bootstrap" first.`);
		database.destroy();
		process.exit(1);
	}

	try {
		const resolved = path.resolve(process.cwd(), targetPath);

		let dirExists = false;
		let dirNotEmpty = false;

		try {
			const entries = await fs.readdir(resolved);
			dirExists = true;
			dirNotEmpty = entries.length > 0;
		} catch {
			dirExists = false;
		}

		if (dirExists && dirNotEmpty && options?.yes !== true) {
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

		const config = await getConfigSnapshot({ database });

		await writeConfigDirectory(config, resolved);

		logger.info(
			`Snapshot: ${config.roles.length} role(s), ${config.permissions.length} permission set(s) written to ${resolved}`
		);

		database.destroy();
		process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}
