import getDatabase from '../../../database/index.js';
import { InvalidPayloadException } from '../../../exceptions/index.js';
import logger from '../../../logger.js';
import { getPortableSnapshot } from '../../../utils/get-portable-snapshot.js';
import { getSnapshot } from '../../../utils/get-snapshot.js';
import { DEFAULT_SNAPSHOT_VERSION, type SnapshotVersion } from '../../../utils/schema-contract.js';
import { validateSnapshotVersion } from '../../../utils/validate-snapshot.js';
import { promises as fs } from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { dump as toYaml, load as loadYaml } from 'js-yaml';

export async function snapshot(
	snapshotPath?: string,
	options?: { yes: boolean; format: 'json' | 'yaml' }
): Promise<void> {
	const database = getDatabase();

	try {
		const filename = snapshotPath ? path.resolve(process.cwd(), snapshotPath) : undefined;
		const existingVersion = filename ? await readExistingVersion(filename) : undefined;
		const version = existingVersion ?? DEFAULT_SNAPSHOT_VERSION;

		const storedSnapshot = await getSnapshot({ database });
		const snapshot = version === 2 ? await getPortableSnapshot(storedSnapshot, { database }) : storedSnapshot;

		let snapshotString: string;

		if (options?.format === 'yaml') {
			snapshotString = toYaml(snapshot);
		} else {
			snapshotString = JSON.stringify(snapshot);
		}

		if (filename) {
			if (existingVersion !== undefined && options?.yes === false) {
				const { overwrite } = await inquirer.prompt([
					{
						type: 'confirm',
						name: 'overwrite',
						message: 'Snapshot already exists. Do you want to overwrite the file?',
					},
				]);

				if (overwrite === false) {
					database.destroy();
					process.exit(0);
				}
			}

			await fs.writeFile(filename, snapshotString);
			logger.info(`Snapshot saved to ${filename}`);
		} else {
			process.stdout.write(snapshotString);
		}

		database.destroy();
		process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}

async function readExistingVersion(filename: string): Promise<SnapshotVersion | undefined> {
	let contents: string;

	try {
		contents = await fs.readFile(filename, 'utf8');
	} catch (err: any) {
		if (err?.code === 'ENOENT') return undefined;
		throw err;
	}

	let existing: unknown;

	try {
		existing = loadYaml(contents);
	} catch {
		throw new InvalidPayloadException(
			`The existing snapshot at ${filename} could not be parsed, so its version is unknown.`
		);
	}

	try {
		validateSnapshotVersion(existing);
	} catch (err: any) {
		throw new InvalidPayloadException(`The existing snapshot at ${filename} cannot be updated: ${err.message}`);
	}

	return (existing as { version: SnapshotVersion }).version;
}
