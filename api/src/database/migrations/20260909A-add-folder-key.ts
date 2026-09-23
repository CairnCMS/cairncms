import type { Knex } from 'knex';

// A migration must replay identically on every database for the lifetime of the schema, so this key
// derivation is frozen here and must not import the runtime generator, whose normalization or length
// bound can change. A future identity-algorithm change needs its own forward migration, not an edit here.
const FILENAME_STEM_MAX_LENGTH = 246;
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

function normalizeKey(input: string): string {
	return input
		.normalize('NFKD')
		.replace(COMBINING_MARKS, '')
		.toLowerCase()
		.replace(/[^a-z0-9_\s]/g, '')
		.trim()
		.replace(/\s+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^[0-9_]+/, '');
}

function boundStem(candidate: string, fallback: string, suffix?: number): string {
	if (suffix === undefined) {
		return candidate.slice(0, FILENAME_STEM_MAX_LENGTH);
	}

	const suffixPart = `_${suffix}`;
	const room = Math.max(FILENAME_STEM_MAX_LENGTH - suffixPart.length, 1);
	const base = candidate.slice(0, room).replace(/_+$/, '') || fallback;
	return `${base}${suffixPart}`;
}

function deriveKey(name: string, usedKeys: Set<string>): string {
	let candidate = normalizeKey(name);
	if (candidate === '') candidate = 'folder';

	let key = boundStem(candidate, 'folder');
	let suffix = 2;

	while (usedKeys.has(key)) {
		key = boundStem(candidate, 'folder', suffix);
		suffix++;
	}

	usedKeys.add(key);
	return key;
}

export async function up(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_folders', (table) => {
		table.string('key', 255).nullable();
	});

	const folders = await knex('directus_folders').select('id', 'name').orderBy('id', 'asc');
	const usedKeys = new Set<string>();

	for (const folder of folders) {
		const key = deriveKey(folder.name ?? '', usedKeys);
		await knex('directus_folders').where({ id: folder.id }).update({ key });
	}

	await knex.schema.alterTable('directus_folders', (table) => {
		table.dropNullable('key');
	});

	await knex.schema.alterTable('directus_folders', (table) => {
		table.unique(['key']);
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_folders', (table) => {
		table.dropUnique(['key']);
	});

	await knex.schema.alterTable('directus_folders', (table) => {
		table.dropColumn('key');
	});
}
