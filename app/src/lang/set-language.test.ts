import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { beforeEach, expect, test, vi } from 'vitest';
import { useTranslationsStore } from '@/stores/translations';
import { useUserStore } from '@/stores/user';
import { fetchAll } from '@/utils/fetch-all';
import { i18n } from './index';
import { setLanguage } from './set-language';
import deDE from './translations/de-DE.yaml';
import frFR from './translations/fr-FR.yaml';

vi.mock('@/api');
vi.mock('@/utils/fetch-all');
vi.mock('@/utils/unexpected-error');

let customTranslations: Record<string, { key: string; value: string }[]> = {};

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
	useUserStore().currentUser = { id: 'user-1' } as any;

	customTranslations = {};

	vi.mocked(fetchAll).mockImplementation(async (_url, config: any) => {
		const language = config.params.filter.language._eq;
		return (customTranslations[language] ?? []).map((translation) => ({ language, ...translation }));
	});
});

test('loads the language file and its custom translations', async () => {
	customTranslations = { 'de-DE': [{ key: 'custom_greeting', value: 'Hallo {name}' }] };

	await setLanguage('de-DE');
	await nextTick();

	expect(i18n.global.locale.value).toBe('de-DE');
	expect(i18n.global.t('save')).toBe(deDE.save);
	expect(i18n.global.t('custom_greeting', { name: 'Ada' })).toBe('Hallo Ada');
});

test('shows an edited custom translation and drops a removed one', async () => {
	customTranslations = {
		'de-DE': [
			{ key: 'custom_edited', value: 'Vorher' },
			{ key: 'custom_removed', value: 'Weg' },
		],
	};

	await setLanguage('de-DE');
	await nextTick();

	expect(i18n.global.t('custom_edited')).toBe('Vorher');
	expect(i18n.global.t('custom_removed')).toBe('Weg');

	customTranslations = { 'de-DE': [{ key: 'custom_edited', value: 'Nachher' }] };

	await useTranslationsStore().loadTranslations('de-DE');
	await nextTick();

	expect(i18n.global.t('custom_edited')).toBe('Nachher');
	expect(i18n.global.te('custom_removed')).toBe(false);
	expect(i18n.global.t('custom_removed')).toBe('custom_removed');
});

test('keeps custom translations per language when switching away and back', async () => {
	customTranslations = {
		'de-DE': [{ key: 'custom_label', value: 'Etikett' }],
		'fr-FR': [{ key: 'custom_label', value: 'Etiquette' }],
	};

	await setLanguage('de-DE');
	await nextTick();

	expect(i18n.global.t('save')).toBe(deDE.save);
	expect(i18n.global.t('custom_label')).toBe('Etikett');

	await setLanguage('fr-FR');
	await nextTick();

	expect(i18n.global.t('save')).toBe(frFR.save);
	expect(i18n.global.t('custom_label')).toBe('Etiquette');

	await setLanguage('de-DE');
	await nextTick();

	expect(i18n.global.t('save')).toBe(deDE.save);
	expect(i18n.global.t('custom_label')).toBe('Etikett');
});

test('renders special characters in a custom translation literally', async () => {
	customTranslations = { 'de-DE': [{ key: 'custom_special', value: 'team@example.com | 5 $ {count}' }] };

	await setLanguage('de-DE');
	await nextTick();

	expect(i18n.global.t('custom_special', { count: 3 })).toBe('team@example.com | 5 $ 3');
});
