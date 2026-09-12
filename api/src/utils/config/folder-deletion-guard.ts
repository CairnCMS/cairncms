import type { Knex } from 'knex';
import type { MutationGuard } from '../../database/mutation-guard.js';
import { ConfigFolderInUseException } from '../../exceptions/index.js';
import type { PrimaryKey } from '../../types/index.js';

function parseOptions(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === 'object') return value as Record<string, unknown>;

	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}

	return undefined;
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

		const referenced = new Set(keys.map((key) => String(key)));
		const fields = await trx.select('options').from('directus_fields').whereNotNull('options');

		for (const field of fields) {
			const options = parseOptions(field['options']);

			if (options && 'folder' in options && referenced.has(String(options['folder']))) {
				throw new ConfigFolderInUseException('Cannot delete a folder referenced by a field interface.', {
					blockedBy: 'options.folder',
				});
			}
		}
	}
}
