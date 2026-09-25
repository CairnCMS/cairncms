import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import api from '@/api';
import type { Field, Relation } from '@cairncms/types';
import { fetchAll } from '@/utils/fetch-all';
import { i18n } from '@/lang';
import { useFieldsStore } from '@/stores/fields';
import { useRelationsStore } from '@/stores/relations';

function fld(collection: string, name: string, primary = false): Field {
	return {
		collection,
		field: name,
		name,
		type: primary ? 'integer' : 'string',
		schema: primary
			? {
					name,
					table: collection,
					data_type: 'integer',
					default_value: null,
					max_length: null,
					numeric_precision: null,
					numeric_scale: null,
					is_nullable: false,
					is_unique: true,
					is_primary_key: true,
					is_generated: false,
					has_auto_increment: true,
					foreign_key_table: null,
					foreign_key_column: null,
			  }
			: null,
		meta: null,
		children: null,
	};
}

function rel(
	collection: string,
	field: string,
	related: string,
	meta: Partial<NonNullable<Relation['meta']>>
): Relation {
	return {
		collection,
		field,
		related_collection: related,
		schema: null,
		meta: {
			id: 0,
			many_collection: collection,
			many_field: field,
			one_collection: related,
			one_field: null,
			one_collection_field: null,
			one_allowed_collections: null,
			one_deselect_action: 'nullify',
			junction_field: null,
			sort_field: null,
			...meta,
		},
	};
}

vi.mock('@/api');
vi.mock('@/utils/fetch-all');
vi.mock('@/utils/unexpected-error');

vi.mock('@/utils/get-literal-interpolated-translation', () => ({
	getLiteralInterpolatedTranslation: (value: string) => value,
}));

vi.mock('@/lang', () => ({
	i18n: { global: { mergeLocaleMessage: vi.fn() } },
}));

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
});

afterEach(() => {
	vi.clearAllMocks();
});

import { useTranslationsStore } from './translations';

const mergeLocaleMessage = vi.mocked(i18n.global.mergeLocaleMessage);

describe('useTranslationsStore', () => {
	test('loadTranslations requests only the given language and merges its keys into that locale', async () => {
		vi.mocked(fetchAll).mockResolvedValue([
			{ language: 'de-DE', key: 'greeting', value: 'Hallo' },
			{ language: 'de-DE', key: 'farewell', value: 'Tschuess' },
		]);

		const store = useTranslationsStore();
		await store.loadTranslations('de-DE');
		await nextTick();

		expect(fetchAll).toHaveBeenCalledWith('/translations', {
			params: {
				fields: ['language', 'key', 'value'],
				filter: { language: { _eq: 'de-DE' } },
			},
		});

		expect(mergeLocaleMessage).toHaveBeenLastCalledWith('de-DE', { greeting: 'Hallo', farewell: 'Tschuess' });
	});

	test('reloading the same language clears a removed key', async () => {
		const store = useTranslationsStore();

		vi.mocked(fetchAll).mockResolvedValue([
			{ language: 'de-DE', key: 'greeting', value: 'Hallo' },
			{ language: 'de-DE', key: 'farewell', value: 'Tschuess' },
		]);

		await store.loadTranslations('de-DE');
		await nextTick();

		vi.mocked(fetchAll).mockResolvedValue([{ language: 'de-DE', key: 'greeting', value: 'Hallo' }]);

		await store.loadTranslations('de-DE');
		await nextTick();

		const [locale, messages] = mergeLocaleMessage.mock.calls.at(-1)!;

		expect(locale).toBe('de-DE');
		expect(messages.greeting).toBe('Hallo');
		expect(Object.prototype.hasOwnProperty.call(messages, 'farewell')).toBe(true);
		expect(messages.farewell).toBeUndefined();
	});

	test('clears a removed key after switching away and back to a language', async () => {
		const store = useTranslationsStore();

		vi.mocked(fetchAll).mockResolvedValue([
			{ language: 'de-DE', key: 'greeting', value: 'Hallo' },
			{ language: 'de-DE', key: 'farewell', value: 'Tschuess' },
		]);

		await store.loadTranslations('de-DE');
		await nextTick();

		vi.mocked(fetchAll).mockResolvedValue([{ language: 'fr-FR', key: 'greeting', value: 'Bonjour' }]);
		await store.loadTranslations('fr-FR');
		await nextTick();

		vi.mocked(fetchAll).mockResolvedValue([{ language: 'de-DE', key: 'greeting', value: 'Hallo' }]);
		await store.loadTranslations('de-DE');
		await nextTick();

		const [locale, messages] = mergeLocaleMessage.mock.calls.at(-1)!;

		expect(locale).toBe('de-DE');
		expect(messages.greeting).toBe('Hallo');
		expect(Object.prototype.hasOwnProperty.call(messages, 'farewell')).toBe(true);
		expect(messages.farewell).toBeUndefined();
	});

	test('create strips a generated reverse marker from a nested relational field before posting', async () => {
		const fieldsStore = useFieldsStore();
		const relationsStore = useRelationsStore();

		fieldsStore.fields = [
			fld('directus_translations', 'id', true),
			fld('directus_translations', 'sections'),
			fld('sections', 'id', true),
			fld('sections', 'translation_id'),
		];

		relationsStore.relations = [
			rel('sections', 'translation_id', 'directus_translations', {
				one_field: 'sections',
				many_field: 'translation_id',
			}),
		];

		vi.mocked(fetchAll).mockResolvedValue([]);

		const store = useTranslationsStore();

		const translation = {
			language: 'de-DE',
			key: 'greeting',
			value: 'Hallo',
			sections: { create: [{ translation_id: '+', title: 'x' }] },
		};

		await store.create(translation);

		expect(api.post).toHaveBeenCalledWith('/translations', {
			language: 'de-DE',
			key: 'greeting',
			value: 'Hallo',
			sections: { create: [{ title: 'x' }] },
		});
	});
});
