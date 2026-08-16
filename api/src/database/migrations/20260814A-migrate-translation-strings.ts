import type { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import logger from '../../logger.js';

type NewTranslationString = {
	id: string;
	key: string;
	language: string;
	value: string;
};

type LegacyTranslationString = {
	key: string;
	translations: Record<string, string>;
};

const STRING_LIMIT = 255;
const MAX_REPORTED_INDEXES = 25;

const ABORT_MESSAGE =
	'Migration aborted: translation strings require reconciliation before this migration can run. See the release notes.';

function abort(reason: string): never {
	logger.error(`Cannot migrate translation strings: ${reason}.`);
	throw new Error(ABORT_MESSAGE);
}

function abortWithIndexes(context: string, indexes: number[]): never {
	const shown = indexes.slice(0, MAX_REPORTED_INDEXES).join(', ');
	const omitted = indexes.length - MAX_REPORTED_INDEXES;
	const suffix = omitted > 0 ? ` and ${omitted} more` : '';
	abort(`${indexes.length} ${context} at source indexes ${shown}${suffix}`);
}

function isRepresentableString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= STRING_LIMIT;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNewRows(parsed: unknown): NewTranslationString[] {
	if (!Array.isArray(parsed)) {
		abort('the stored value is not an array');
	}

	const unrepresentable: number[] = [];
	const duplicates: number[] = [];
	const seen = new Map<string, Set<string>>();
	const rows: NewTranslationString[] = [];

	parsed.forEach((entry, index) => {
		if (!isPlainObject(entry) || !isRepresentableString(entry['key']) || !isPlainObject(entry['translations'])) {
			unrepresentable.push(index);
			return;
		}

		const key = entry['key'] as string;
		const translations = entry['translations'] as Record<string, unknown>;
		const languages = Object.keys(translations);

		if (languages.length === 0) {
			unrepresentable.push(index);
			return;
		}

		for (const language of languages) {
			if (!isRepresentableString(language) || typeof translations[language] !== 'string') {
				unrepresentable.push(index);
				return;
			}
		}

		let seenLanguages = seen.get(key);

		if (!seenLanguages) {
			seenLanguages = new Set<string>();
			seen.set(key, seenLanguages);
		}

		for (const language of languages) {
			if (seenLanguages.has(language)) {
				duplicates.push(index);
				return;
			}

			seenLanguages.add(language);
			rows.push({ id: uuid(), key, language, value: translations[language] as string });
		}
	});

	if (unrepresentable.length > 0) {
		abortWithIndexes('unrepresentable entries', unrepresentable);
	}

	if (duplicates.length > 0) {
		abortWithIndexes('duplicate (key, language) entries', duplicates);
	}

	return rows;
}

function toLegacyFormat(
	rows: Array<Pick<NewTranslationString, 'key' | 'language' | 'value'>>
): LegacyTranslationString[] {
	// A Map plus null-prototype records so keys or languages named __proto__, constructor, or
	// prototype are stored as ordinary data instead of being dropped as object internals.
	const byKey = new Map<string, Record<string, string>>();

	for (const { key, language, value } of rows) {
		let translations = byKey.get(key);

		if (!translations) {
			translations = Object.create(null) as Record<string, string>;
			byKey.set(key, translations);
		}

		translations[language] = value;
	}

	return Array.from(byKey, ([key, translations]) => ({ key, translations }));
}

function parseLegacyValue(raw: unknown): unknown {
	if (typeof raw !== 'string') {
		return raw;
	}

	try {
		return JSON.parse(raw);
	} catch {
		abort('the stored value is not valid JSON');
	}
}

async function collectRows(knex: Knex): Promise<NewTranslationString[]> {
	const settings = await knex.select('translation_strings').from('directus_settings').first();
	const raw = settings?.translation_strings;

	// Only SQL/JSON null (or an absent settings row) is the empty state. Any other value, including a
	// falsy scalar, is routed through the representability preflight rather than silently discarded.
	if (raw === null || raw === undefined) {
		return [];
	}

	return toNewRows(parseLegacyValue(raw));
}

export async function up(knex: Knex): Promise<void> {
	// If the source column is gone, a prior run already completed the copy.
	if (!(await knex.schema.hasColumn('directus_settings', 'translation_strings'))) {
		return;
	}

	// With the source still present, a target table cannot be proven to be this migration's own
	// interrupted work rather than an unrelated table (a DBA, extension, or manual deploy could have
	// created it), so fail closed and leave both untouched.
	if (await knex.schema.hasTable('directus_translations')) {
		throw new Error(
			'Migration aborted: a directus_translations table already exists. Remove it if it is left over from an interrupted run, or reconcile it, then run the migration again.'
		);
	}

	const rows = await collectRows(knex);

	await knex.schema.createTable('directus_translations', (table) => {
		table.uuid('id').primary().notNullable();
		table.string('language').notNullable();
		table.string('key').notNullable();
		table.text('value').notNullable();
		table.unique(['key', 'language']);
	});

	try {
		for (const row of rows) {
			await knex('directus_translations').insert(row);
		}
	} catch {
		// The table was created in this run, so dropping it on a copy failure leaves the source
		// intact and the migration rerunnable.
		await knex.schema.dropTableIfExists('directus_translations');

		throw new Error(
			'Migration aborted: copying translation strings failed and the source data is unchanged. Resolve the database error and run the migration again.'
		);
	}

	await knex.schema.alterTable('directus_settings', (table) => {
		table.dropColumn('translation_strings');
	});
}

export async function down(knex: Knex): Promise<void> {
	const rows = await knex.select('key', 'language', 'value').from('directus_translations');
	const settings = await knex.select('id').from('directus_settings').first();

	if (!(await knex.schema.hasColumn('directus_settings', 'translation_strings'))) {
		await knex.schema.alterTable('directus_settings', (table) => {
			table.json('translation_strings');
		});
	}

	if (settings?.id) {
		await knex('directus_settings')
			.where({ id: settings.id })
			.update({ translation_strings: JSON.stringify(toLegacyFormat(rows)) });
	}

	await knex.schema.dropTableIfExists('directus_translations');
}
