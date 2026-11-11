import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { i18n } from '@/lang';
import { Collection } from '@cairncms/types';
import { merge } from 'lodash';
import { useCollectionsStore } from './collections';

beforeEach(() => {
	setActivePinia(
		createTestingPinia({
			createSpy: vi.fn,
			stubActions: false,
		})
	);
});

const mockCollection = {
	collection: 'a',
	meta: {},
	schema: {},
} as Collection;

test('parseField action should translate field name when translations are added then removed', async () => {
	const collectionsStore = useCollectionsStore();

	const mockCollectionWithTranslations = merge({}, mockCollection, {
		meta: {
			translations: [
				{
					language: 'en-US',
					translation: 'Collection A en-US',
				},
			],
		},
	});

	collectionsStore.collections = [mockCollectionWithTranslations].map(collectionsStore.prepareCollectionForApp);
	expect(collectionsStore.collections[0].name).toEqual('Collection A en-US');
	expect(i18n.global.te(`collection_names.${mockCollection.collection}`)).toBe(true);

	const mockCollectionWithMissingTranslations = merge({}, mockCollection, {
		meta: {
			translations: [
				{
					language: 'zh-CN',
					translation: 'Collection A zh-CN',
				},
			],
		},
	});

	collectionsStore.collections = [mockCollectionWithMissingTranslations].map(collectionsStore.prepareCollectionForApp);
	expect(collectionsStore.collections[0].name).toEqual('A');
	expect(i18n.global.te(`collection_names.${mockCollection.collection}`)).toBe(false);
});

test('parseField action should translate field name when all translations are removed', async () => {
	const collectionsStore = useCollectionsStore();

	const mockCollectionWithTranslations = merge({}, mockCollection, {
		meta: {
			translations: [
				{
					language: 'en-US',
					translation: 'Collection A en-US',
				},
			],
		},
	});

	collectionsStore.collections = [mockCollectionWithTranslations].map(collectionsStore.prepareCollectionForApp);
	expect(collectionsStore.collections[0].name).toEqual('Collection A en-US');
	expect(i18n.global.te(`collection_names.${mockCollection.collection}`)).toBe(true);

	const mockCollectionWithoutTranslations = merge({}, mockCollection, {
		meta: {
			translations: null,
		},
	});

	collectionsStore.collections = [mockCollectionWithoutTranslations].map(collectionsStore.prepareCollectionForApp);
	expect(collectionsStore.collections[0].name).toEqual('A');
	expect(i18n.global.te(`collection_names.${mockCollection.collection}`)).toBe(false);
});

describe('in a non-English locale', () => {
	afterEach(() => {
		i18n.global.locale.value = 'en-US';
	});

	test('uses the translation for the current locale after a language switch', () => {
		const collectionsStore = useCollectionsStore();

		const articles = merge({}, mockCollection, {
			collection: 'articles',
			meta: {
				translations: [
					{ language: 'en-US', translation: 'Articles en-US' },
					{ language: 'de-DE', translation: 'Artikel de-DE' },
				],
			},
		});

		collectionsStore.collections = [articles].map(collectionsStore.prepareCollectionForApp);
		expect(collectionsStore.collections[0].name).toEqual('Articles en-US');

		i18n.global.locale.value = 'de-DE';
		collectionsStore.translateCollections();
		expect(collectionsStore.collections[0].name).toEqual('Artikel de-DE');
	});

	test('falls back to the English translation when the current locale has none', () => {
		i18n.global.locale.value = 'de-DE';
		const collectionsStore = useCollectionsStore();

		const authors = merge({}, mockCollection, {
			collection: 'authors',
			meta: { translations: [{ language: 'en-US', translation: 'Authors en-US' }] },
		});

		collectionsStore.collections = [authors].map(collectionsStore.prepareCollectionForApp);
		expect(collectionsStore.collections[0].name).toEqual('Authors en-US');
		expect(i18n.global.te('collection_names.authors')).toBe(true);
	});

	test('resets the name when the translations are removed', () => {
		i18n.global.locale.value = 'de-DE';
		const collectionsStore = useCollectionsStore();

		const pages = merge({}, mockCollection, {
			collection: 'pages',
			meta: { translations: [{ language: 'de-DE', translation: 'Seiten de-DE' }] },
		});

		collectionsStore.collections = [pages].map(collectionsStore.prepareCollectionForApp);
		expect(collectionsStore.collections[0].name).toEqual('Seiten de-DE');

		const pagesWithoutTranslations = merge({}, mockCollection, { collection: 'pages', meta: { translations: null } });

		collectionsStore.collections = [pagesWithoutTranslations].map(collectionsStore.prepareCollectionForApp);
		expect(collectionsStore.collections[0].name).toEqual('Pages');
		expect(i18n.global.te('collection_names.pages')).toBe(false);
	});
});
