import { isPlainObject } from 'lodash-es';
import type { Knex } from 'knex';
import type { MutationGuard } from '../../database/mutation-guard.js';
import { ConfigFolderInUseException } from '../../exceptions/index.js';
import type { PrimaryKey } from '../../types/index.js';
import { parseJsonColumn, visitFolderReferences } from '../folder-references.js';
import { resolveFolderReference } from './folder-id-lookup.js';

export async function readFieldFolderReferences(database: Knex): Promise<unknown[]> {
	const fields = await database
		.select('interface', 'options', 'conditions')
		.from('directus_fields')
		.where((query) => query.whereNotNull('options').orWhereNotNull('conditions'));

	const references: unknown[] = [];

	for (const field of fields) {
		const options = parseJsonColumn(field['options']);

		if (isPlainObject(options)) references.push((options as Record<string, unknown>)['folder']);

		visitFolderReferences(
			{ interface: field['interface'], options, conditions: parseJsonColumn(field['conditions']) },
			(_path, value) => references.push(value)
		);
	}

	return references;
}

export class FolderDeletionGuard implements MutationGuard {
	async beforeDelete(keys: PrimaryKey[], trx: Knex): Promise<void> {
		if (keys.length === 0) return;

		const file = await trx.select('id').from('directus_files').whereIn('folder', keys).first();

		if (file) {
			throw new ConfigFolderInUseException('Cannot delete a folder that still contains files.', {
				blockedBy: 'files',
			});
		}

		const child = await trx
			.select('id')
			.from('directus_folders')
			.whereIn('parent', keys)
			.whereNotIn('id', keys)
			.first();

		if (child) {
			throw new ConfigFolderInUseException('Cannot delete a folder that still has child folders.', {
				blockedBy: 'folders',
			});
		}

		const setting = await trx.select('id').from('directus_settings').whereIn('storage_default_folder', keys).first();

		if (setting) {
			throw new ConfigFolderInUseException('Cannot delete a folder set as the default storage folder.', {
				blockedBy: 'storage_default_folder',
			});
		}

		const deletedIds = new Map<string, true>(keys.map((key) => [String(key), true]));

		for (const reference of await readFieldFolderReferences(trx)) {
			if (await resolveFolderReference(trx, deletedIds, reference)) {
				throw new ConfigFolderInUseException('Cannot delete a folder referenced by a field interface.', {
					blockedBy: 'options.folder',
				});
			}
		}
	}
}
