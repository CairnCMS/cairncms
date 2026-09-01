import inquirer from 'inquirer';
import getDatabase, { hasDatabaseConnection, isInstalled } from '../../../database/index.js';
import logger from '../../../logger.js';
import { configFailureExitCode } from './exit-code.js';
import { readContainedDirectory, resolveConfigRoot } from '../../../utils/config-path-safety.js';
import { readCurrentConfig } from '../../../utils/get-config-snapshot.js';
import { readOptionalConfigManifest } from '../../../utils/read-config-directory.js';
import { replaceControlCharacters } from '../../../utils/safe-log-fragment.js';
import { CONFIG_KINDS } from '../../../types/config.js';
import { SUPPORTED_MANIFEST_VERSION } from '../../../utils/config-contract.js';
import { writeConfigDirectory } from '../../../utils/write-config-directory.js';
import { isHttpTarget, parseOperatorRemoteTarget } from './operator-remote-target.js';
import { createOperatorRemoteTransport } from './operator-remote-transport.js';
import {
	assertServerSupportsRemoteConfig,
	fetchRemoteSnapshot,
	fetchServerVersion,
	type RemoteSession,
} from './remote-client.js';
import { resolveRemoteToken } from './remote-token.js';
import { readFileSync } from 'node:fs';

export async function configSnapshot(
	targetPath: string,
	options?: { yes: boolean; url?: string; tokenStdin?: boolean }
): Promise<void> {
	if (options?.url !== undefined) {
		return configSnapshotRemote(targetPath, options.url, options);
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

async function configSnapshotRemote(
	targetPath: string,
	url: string,
	options: { yes?: boolean; tokenStdin?: boolean }
): Promise<void> {
	try {
		const target = parseOperatorRemoteTarget(url);
		const resolved = await resolveConfigRoot(targetPath, 'write');
		const existing = await readContainedDirectory(resolved, resolved);
		const dirNotEmpty = (existing ?? []).length > 0;

		if (dirNotEmpty && options.yes !== true) {
			if (options.tokenStdin === true) {
				logger.error(
					'Snapshotting into a non-empty directory with --token-stdin requires --yes, because stdin is consumed by the token.'
				);

				process.exit(2);
			}

			const { overwrite } = await inquirer.prompt([
				{ type: 'confirm', name: 'overwrite', message: `Directory "${resolved}" is not empty. Overwrite?` },
			]);

			if (overwrite === false) process.exit(0);
		}

		const declared = await readOptionalConfigManifest(resolved);
		const manifestVersion = declared?.version ?? SUPPORTED_MANIFEST_VERSION;
		const resources = declared?.resources ?? [...CONFIG_KINDS];

		const token = resolveRemoteToken({
			envToken: process.env['CAIRNCMS_TOKEN'],
			tokenFile: process.env['CAIRNCMS_TOKEN_FILE'],
			tokenStdin: options.tokenStdin === true,
			readStdin: () => readFileSync(0, 'utf8'),
		});

		if (isHttpTarget(target)) {
			logger.warn('The admin token will be sent over http:// without transport encryption. Prefer https://.');
		}

		const transport = await createOperatorRemoteTransport();
		const session: RemoteSession = { transport, target, token };

		assertServerSupportsRemoteConfig(await fetchServerVersion(session), session.token);

		const config = await fetchRemoteSnapshot(session, { manifestVersion, resources });

		await writeConfigDirectory(config, resolved);

		const where = replaceControlCharacters(resolved);

		logger.info(
			`Snapshot: ${config.roles.length} role(s), ${config.permissions.length} permission set(s) written to ${where}`
		);

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
