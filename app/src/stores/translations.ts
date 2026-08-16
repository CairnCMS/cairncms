import api from '@/api';
import { i18n } from '@/lang';
import { fetchAll } from '@/utils/fetch-all';
import { getLiteralInterpolatedTranslation } from '@/utils/get-literal-interpolated-translation';
import { unexpectedError } from '@/utils/unexpected-error';
import { defineStore } from 'pinia';
import { ref, unref, watch } from 'vue';

export interface Translation {
	language: string;
	key: string;
	value: string;
}

export const useTranslationsStore = defineStore('translations', () => {
	const loading = ref(false);
	const translations = ref<Translation[]>([]);
	const lang = ref<string>('en-US');

	// Keys merged per language, so a reload clears keys removed since that language last loaded.
	const merged = new Map<string, string[]>();

	const loadTranslations = async (newLang = unref(lang)) => {
		loading.value = true;

		try {
			translations.value = await fetchAll(`/translations`, {
				params: {
					fields: ['language', 'key', 'value'],
					filter: {
						language: { _eq: newLang },
					},
				},
			});

			lang.value = newLang;
		} catch (err: any) {
			unexpectedError(err);
		} finally {
			loading.value = false;
		}
	};

	const create = async (translation: Translation) => {
		try {
			await api.post('/translations', translation);
			await loadTranslations();
		} catch (err: any) {
			unexpectedError(err);
		}
	};

	watch(translations, (newTranslations) => {
		const activeLang = unref(lang);
		const localeMessages: Record<string, string | undefined> = {};

		for (const key of merged.get(activeLang) ?? []) {
			localeMessages[key] = undefined;
		}

		const nextKeys: string[] = [];

		for (const { key, value } of newTranslations ?? []) {
			localeMessages[key] = getLiteralInterpolatedTranslation(value, true);
			nextKeys.push(key);
		}

		merged.set(activeLang, nextKeys);
		i18n.global.mergeLocaleMessage(activeLang, localeMessages);
	});

	return { loading, translations, loadTranslations, create };
});
