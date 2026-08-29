import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchAll } from '@/utils/fetch-all';
import { i18n } from '@/lang';

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
});
