import type { Knex } from 'knex';

const TABLE = 'cairncms_extension_settings';

export type StoredSettingRow = {
	key: string;
	value: unknown;
};

/**
 * Reads a subject's global-scoped settings for the confined runtime. This is a
 * system-internal read with no accountability and no admin gate, kept free of any
 * import of extensions.ts so the runtime path cannot close an import cycle.
 */
export async function readGlobalSettings(
	knex: Knex,
	subject: string,
	signal?: AbortSignal
): Promise<StoredSettingRow[]> {
	if (signal?.aborted) return [];

	const rows = await knex(TABLE).where({ extension: subject, scope: 'global', scope_key: '' }).select('key', 'value');

	if (signal?.aborted) return [];

	const settings: StoredSettingRow[] = [];

	for (const row of rows) {
		try {
			settings.push({ key: row.key, value: JSON.parse(row.value) });
		} catch {
			// A corrupt row is unusable. Omit it so the runtime read never throws.
		}
	}

	return settings;
}

/**
 * Reads a subject's collection-scoped settings for one collection. A system-internal read with
 * no accountability, kept free of any import of extensions.ts so the read path cannot close an
 * import cycle. The caller filters by app-readability and applies collection authority.
 */
export async function readCollectionSettings(
	knex: Knex,
	subject: string,
	collection: string,
	signal?: AbortSignal
): Promise<StoredSettingRow[]> {
	if (signal?.aborted) return [];

	const rows = await knex(TABLE)
		.where({ extension: subject, scope: 'collection', scope_key: collection })
		.select('key', 'value');

	if (signal?.aborted) return [];

	const settings: StoredSettingRow[] = [];

	for (const row of rows) {
		try {
			settings.push({ key: row.key, value: JSON.parse(row.value) });
		} catch {
			// A corrupt row is unusable. Omit it so the read never throws.
		}
	}

	return settings;
}

/**
 * Deletes a collection's collection-scoped settings as part of a collection delete. Runs on the
 * caller's transaction handle. Global settings and other collections' settings are untouched.
 */
export async function deleteSettingsByCollection(knex: Knex, collection: string): Promise<number> {
	return knex(TABLE).where({ scope: 'collection', scope_key: collection }).delete();
}
