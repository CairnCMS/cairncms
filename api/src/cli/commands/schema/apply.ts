import { parseJSON } from '@cairncms/utils';
import chalk from 'chalk';
import type { Diff } from 'deep-diff';
import { promises as fs } from 'fs';
import inquirer from 'inquirer';
import { load as loadYaml } from 'js-yaml';
import path from 'path';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import logger from '../../../logger.js';
import { confirmPrompt, createVerb, deleteVerb, heading, planIntro, updateVerb } from '../../presentation.js';
import type { Collection, Snapshot } from '../../../types/index.js';
import { DiffKind } from '../../../types/index.js';
import { isEntityDelete } from '../../../utils/is-entity-delete.js';
import { isNestedMetaUpdate } from '../../../utils/is-nested-meta-update.js';
import { schemaDiffOperation } from '../../../utils/schema-diff-operation.js';
import { applyDiff } from '../../../utils/apply-diff.js';
import { toKeyFormSnapshot } from '../../../utils/folder-references.js';
import { getSnapshot } from '../../../utils/get-snapshot.js';
import { getTargetSnapshotDiff } from '../../../utils/get-target-snapshot-diff.js';
import { getVersionedHash } from '../../../utils/get-versioned-hash.js';
import { replaceControlCharacters } from '../../../utils/safe-log-fragment.js';
import { isUnconfiguredTableDrop, unconfiguredTableDropMessage } from '../../../utils/unconfigured-table-drop.js';

export async function apply(snapshotPath: string, options?: { yes: boolean; dryRun: boolean }): Promise<void> {
	const filename = path.resolve(process.cwd(), snapshotPath);

	const database = getDatabase();

	await validateDatabaseConnection(database);

	if ((await isInstalled()) === false) {
		logger.error(`System tables are not installed on this database. Please run "cairncms bootstrap" first.`);
		database.destroy();
		process.exit(0);
	}

	let snapshot: Snapshot;

	try {
		const fileContents = await fs.readFile(filename, 'utf8');

		if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
			snapshot = (await loadYaml(fileContents)) as Snapshot;
		} else {
			snapshot = parseJSON(fileContents) as Snapshot;
		}

		const currentSnapshot = await getSnapshot({ database });
		const currentKeyForm = await toKeyFormSnapshot(currentSnapshot, { database });

		const snapshotDiff = await getTargetSnapshotDiff(snapshot, {
			current: currentSnapshot,
			currentKeyForm,
			database,
		});

		if (
			snapshotDiff.collections.length === 0 &&
			snapshotDiff.fields.length === 0 &&
			snapshotDiff.relations.length === 0
		) {
			logger.info('No changes to apply.');
			database.destroy();
			process.exit(0);
		}

		const dryRun = options?.dryRun === true;
		const promptForChanges = !dryRun && options?.yes !== true;

		const tableDropWarnings = snapshotDiff.collections
			.filter(({ diff }) => isEntityDelete(diff[0]) && isUnconfiguredTableDrop((diff[0] as { lhs?: Collection }).lhs))
			.map(({ collection }) => unconfiguredTableDropMessage(collection));

		if (dryRun || promptForChanges) {
			let message = '';

			if (snapshotDiff.collections.length > 0) {
				message += heading('Collections');

				for (const { collection, diff } of snapshotDiff.collections) {
					const name = replaceControlCharacters(collection);

					if (isEntityDelete(diff[0])) {
						message += `\n  - ${deleteVerb()} ${name}`;
					} else if (diff[0]?.kind === DiffKind.NEW && !isNestedMetaUpdate(diff[0])) {
						message += `\n  - ${createVerb()} ${name}`;
					} else {
						message += `\n  - ${updateVerb()} ${name}` + describeChanges(diff);
					}
				}
			}

			if (snapshotDiff.fields.length > 0) {
				message += '\n\n' + heading('Fields');

				for (const { collection, field, diff } of snapshotDiff.fields) {
					const operation = schemaDiffOperation(diff);
					const name = replaceControlCharacters(`${collection}.${field}`);

					if (operation === 'create') {
						message += `\n  - ${createVerb()} ${name}`;
					} else if (operation === 'delete') {
						message += `\n  - ${deleteVerb()} ${name}`;
					} else {
						message += `\n  - ${updateVerb()} ${name}` + describeChanges(diff);
					}
				}
			}

			if (snapshotDiff.relations.length > 0) {
				message += '\n\n' + heading('Relations');

				for (const { collection, field, related_collection, diff } of snapshotDiff.relations) {
					const operation = schemaDiffOperation(diff);
					const target = related_collection ? `-> ${related_collection}` : '';
					const relation = replaceControlCharacters(`${collection}.${field}${target}`);

					if (operation === 'create') {
						message += `\n  - ${createVerb()} ${relation}`;
					} else if (operation === 'delete') {
						message += `\n  - ${deleteVerb()} ${relation}`;
					} else {
						message += `\n  - ${updateVerb()} ${relation}` + describeChanges(diff);
					}
				}
			}

			if (tableDropWarnings.length > 0) {
				message += '\n\n' + heading('Warnings');
				for (const warning of tableDropWarnings) message += `\n  - ${warning}`;
			}

			message = planIntro + '\n\n' + chalk.black(message);

			if (dryRun) {
				logger.info(message);
				process.exit(0);
			}

			const { proceed } = await inquirer.prompt([
				{
					type: 'confirm',
					name: 'proceed',
					message: message + '\n\n' + confirmPrompt,
				},
			]);

			if (proceed === false) {
				process.exit(0);
			}
		}

		if (!dryRun && !promptForChanges && tableDropWarnings.length > 0) {
			for (const warning of tableDropWarnings) logger.warn(warning);
		}

		await applyDiff(snapshotDiff, { database, expectedHash: getVersionedHash(currentKeyForm.snapshot) });

		logger.info(`Snapshot applied successfully`);

		database.destroy();
		process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}

function describeChanges(diff: readonly Diff<unknown>[]): string {
	let lines = '';

	for (const change of diff) {
		const segments = change.path ?? [];
		const path = replaceControlCharacters(segments.slice(1).join('.') || segments.join('.'));

		if (change.kind === DiffKind.EDIT) {
			lines += `\n    - Set ${path} to ${replaceControlCharacters(change.rhs)}`;
		} else if (change.kind === DiffKind.DELETE) {
			lines += `\n    - Remove ${path}`;
		} else if (change.kind === DiffKind.NEW) {
			lines += `\n    - Add ${path} and set it to ${replaceControlCharacters(change.rhs)}`;
		}
	}

	return lines;
}
