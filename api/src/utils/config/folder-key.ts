import type { Knex } from 'knex';
import { normalizeConfigKey } from '@cairncms/utils';
import { InvalidPayloadException } from '../../exceptions/index.js';
import { CONFIG_FILENAME_STEM_MAX_LENGTH } from '../config-contract.js';
import { generateBoundedKey } from './generate-bounded-key.js';

export async function resolveFolderKey(options: {
	action: 'create' | 'read' | 'update';
	value: unknown;
	name: unknown;
	knex: Knex;
}): Promise<unknown> {
	const { action, value, name, knex } = options;

	if (action !== 'create') return value;

	if (value !== undefined) {
		if (typeof value !== 'string' || value === '' || normalizeConfigKey(value) !== value) {
			throw new InvalidPayloadException(
				`Invalid folder key ${JSON.stringify(
					value
				)}. Keys must be lowercase alphanumeric with underscores, and cannot start with a digit.`
			);
		}

		if (value.length > CONFIG_FILENAME_STEM_MAX_LENGTH) {
			throw new InvalidPayloadException(
				`Folder key is too long (${value.length} characters). The maximum is ${CONFIG_FILENAME_STEM_MAX_LENGTH}.`
			);
		}

		return value;
	}

	const rows = await knex.select('key').from('directus_folders');
	const usedKeys = new Set<string>(rows.map((row: { key: string }) => row.key));

	return generateBoundedKey(typeof name === 'string' ? name : '', usedKeys, { fallback: 'folder' });
}
