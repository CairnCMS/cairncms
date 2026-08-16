import knex from 'knex';
import type { Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import logger from '../../logger.js';
import { down, up } from './20260814A-migrate-translation-strings.js';

vi.mock('../../logger.js', () => ({
	default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function canonical(strings: Array<{ key: string; translations: Record<string, string> }>): string[] {
	const out: string[] = [];

	for (const { key, translations } of strings) {
		for (const [language, value] of Object.entries(translations)) {
			out.push(JSON.stringify([key, language, value]));
		}
	}

	return out.sort();
}

describe('20260814A-migrate-translation-strings', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			useNullAsDefault: true,
			connection: ':memory:',
			pool: { min: 1, max: 1 },
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.json('translation_strings');
		});

		vi.mocked(logger.error).mockClear();
	});

	afterEach(async () => {
		await db.destroy();
	});

	test('up then down preserves data, including dotted and prototype-sensitive keys and languages', async () => {
		const fixture = [
			{ key: 'greeting', translations: { 'en-US': 'Hello', 'fr-FR': 'Bonjour' } },
			{ key: 'a.b.c', translations: { 'en-US': 'dotted' } },
			{ key: '__proto__', translations: { 'en-US': 'proto-key' } },
			{ key: 'constructor', translations: { 'en-US': 'ctor-key' } },
			{
				key: 'multi',
				translations: { ['__proto__']: 'proto-lang', constructor: 'ctor-lang', prototype: 'proto2-lang' },
			},
		];

		await db('directus_settings').insert({ translation_strings: JSON.stringify(fixture) });

		await up(db);

		expect(await db.schema.hasColumn('directus_settings', 'translation_strings')).toBe(false);
		expect(await db.schema.hasTable('directus_translations')).toBe(true);

		await down(db);

		const restored = JSON.parse(
			(await db.select('translation_strings').from('directus_settings').first())!.translation_strings
		);

		expect(canonical(restored)).toEqual(canonical(fixture));
	});

	test('an unrepresentable entry aborts before mutation with a content-free error', async () => {
		const seededKey = 'DISTINCTIVE_SEEDED_KEY_a1b2c3';

		await db('directus_settings').insert({
			translation_strings: JSON.stringify([{ key: seededKey, translations: {} }]),
		});

		let message = '';

		try {
			await up(db);
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toBeTruthy();
		expect(await db.schema.hasColumn('directus_settings', 'translation_strings')).toBe(true);
		expect(await db.schema.hasTable('directus_translations')).toBe(false);

		const logged = vi
			.mocked(logger.error)
			.mock.calls.map((call) => String(call[0]))
			.join('\n');

		expect(message).not.toContain(seededKey);
		expect(logged).not.toContain(seededKey);
	});

	test('a falsy non-null legacy value aborts before mutation', async () => {
		await db('directus_settings').insert({ translation_strings: JSON.stringify(false) });

		await expect(up(db)).rejects.toThrow();

		expect(await db.schema.hasColumn('directus_settings', 'translation_strings')).toBe(true);
		expect(await db.schema.hasTable('directus_translations')).toBe(false);
	});

	test('fails closed and preserves both copies when a target table already exists', async () => {
		await db('directus_settings').insert({
			translation_strings: JSON.stringify([{ key: 'source', translations: { 'en-US': 'kept' } }]),
		});

		await db.schema.createTable('directus_translations', (table) => {
			table.uuid('id').primary().notNullable();
			table.string('language').notNullable();
			table.string('key').notNullable();
			table.text('value').notNullable();
			table.unique(['key', 'language']);
		});

		await db('directus_translations').insert({
			id: '00000000-0000-0000-0000-000000000001',
			key: 'sentinel',
			language: 'en-US',
			value: 'preexisting',
		});

		await expect(up(db)).rejects.toThrow();

		expect(await db.schema.hasColumn('directus_settings', 'translation_strings')).toBe(true);

		const keys = (await db.select('key').from('directus_translations')).map((row: { key: string }) => row.key);

		expect(keys).toEqual(['sentinel']);
	});
});
