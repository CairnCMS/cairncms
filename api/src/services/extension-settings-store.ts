import type { Knex } from 'knex';

const TABLE = 'cairncms_extension_settings';

export type StoredGlobalSetting = {
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
): Promise<StoredGlobalSetting[]> {
	if (signal?.aborted) return [];

	const rows = await knex(TABLE).where({ extension: subject, scope: 'global', scope_key: '' }).select('key', 'value');

	if (signal?.aborted) return [];

	const settings: StoredGlobalSetting[] = [];

	for (const row of rows) {
		try {
			settings.push({ key: row.key, value: JSON.parse(row.value) });
		} catch {
			// A corrupt row is unusable. Omit it so the runtime read never throws.
		}
	}

	return settings;
}
