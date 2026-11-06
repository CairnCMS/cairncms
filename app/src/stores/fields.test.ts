import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { i18n } from '@/lang';
import { Field } from '@cairncms/types';
import { merge } from 'lodash';
import { useFieldsStore } from './fields';

beforeEach(() => {
	setActivePinia(
		createTestingPinia({
			createSpy: vi.fn,
			stubActions: false,
		})
	);
});

const mockField = {
	collection: 'a',
	field: 'name',
	type: 'string',
	schema: {},
	meta: {
		collection: 'a',
		field: 'name',
		options: null,
		display_options: null,
		note: null,
		validation_message: null,
	},
} as Field;

vi.mock('@/api', () => {
	return {
		default: {
			get: (path: string) => {
				if (path === '/fields') {
					return Promise.resolve({
						data: {
							data: [mockField],
						},
					});
				}

				return Promise.reject(new Error(`Path "${path}" is not mocked in this test`));
			},
		},
	};
});

describe('hydrate action', () => {
	test('should not skip translations by default', async () => {
		const fieldsStore = useFieldsStore();
		const translateFieldsSpy = vi.spyOn(fieldsStore, 'translateFields');
		await fieldsStore.hydrate();

		expect(translateFieldsSpy).toHaveBeenCalledOnce();
	});

	test('should skip translations when skipTranslation is true', async () => {
		const fieldsStore = useFieldsStore();
		const translateFieldsSpy = vi.spyOn(fieldsStore, 'translateFields');
		await fieldsStore.hydrate({ skipTranslation: true });

		expect(translateFieldsSpy).not.toHaveBeenCalled();
	});
});

describe('parseField action', () => {
	test('should translate field name when translations are added then removed', async () => {
		const fieldsStore = useFieldsStore();

		const mockFieldWithTranslations = merge({}, mockField, {
			meta: {
				translations: [
					{
						language: 'en-US',
						translation: 'Name en-US',
					},
				],
			},
		});

		fieldsStore.fields = [mockFieldWithTranslations].map(fieldsStore.parseField);
		expect(fieldsStore.fields[0].name).toEqual('Name en-US');
		expect(i18n.global.te(`fields.${mockField.collection}.${mockField.field}`)).toBe(true);

		const mockFieldWithoutTranslations = merge({}, mockField, {
			meta: {
				translations: [
					{
						language: 'zh-CN',
						translation: 'Name zh-CN',
					},
				],
			},
		});

		fieldsStore.fields = [mockFieldWithoutTranslations].map(fieldsStore.parseField);
		expect(fieldsStore.fields[0].name).toEqual('Name');
		expect(i18n.global.te(`fields.${mockField.collection}.${mockField.field}`)).toBe(false);
	});

	test('should translate field name when translations are added and reset when removed', async () => {
		const fieldsStore = useFieldsStore();

		const mockFieldWithTranslations = merge({}, mockField, {
			meta: {
				translations: [
					{
						language: 'en-US',
						translation: 'name en-US',
					},
				],
			},
		});

		fieldsStore.fields = [mockFieldWithTranslations].map(fieldsStore.parseField);
		expect(fieldsStore.fields[0].name).toEqual('name en-US');
		expect(i18n.global.te(`fields.${mockField.collection}.${mockField.field}`)).toBe(true);

		const mockFieldWithoutTranslations = merge({}, mockField, {
			meta: {
				translations: null,
			},
		});

		fieldsStore.fields = [mockFieldWithoutTranslations].map(fieldsStore.parseField);
		expect(fieldsStore.fields[0].name).toEqual('Name');
		expect(i18n.global.te(`fields.${mockField.collection}.${mockField.field}`)).toBe(false);
	});
});

describe('parseField action in a non-English locale', () => {
	afterEach(() => {
		i18n.global.locale.value = 'en-US';
	});

	test('uses the translation for the current locale after a language switch', () => {
		const fieldsStore = useFieldsStore();

		const title = merge({}, mockField, {
			field: 'title',
			meta: {
				field: 'title',
				translations: [
					{ language: 'en-US', translation: 'Title en-US' },
					{ language: 'de-DE', translation: 'Titel de-DE' },
				],
			},
		});

		fieldsStore.fields = [title].map(fieldsStore.parseField);
		expect(fieldsStore.fields[0].name).toEqual('Title en-US');

		i18n.global.locale.value = 'de-DE';
		fieldsStore.translateFields();
		expect(fieldsStore.fields[0].name).toEqual('Titel de-DE');
	});

	test('falls back to the English translation when the current locale has none', () => {
		i18n.global.locale.value = 'de-DE';
		const fieldsStore = useFieldsStore();

		const summary = merge({}, mockField, {
			field: 'summary',
			meta: { field: 'summary', translations: [{ language: 'en-US', translation: 'Summary en-US' }] },
		});

		fieldsStore.fields = [summary].map(fieldsStore.parseField);
		expect(fieldsStore.fields[0].name).toEqual('Summary en-US');
		expect(i18n.global.te(`fields.${mockField.collection}.summary`)).toBe(true);
	});

	test('resets the name when the translations are removed', () => {
		i18n.global.locale.value = 'de-DE';
		const fieldsStore = useFieldsStore();

		const body = merge({}, mockField, {
			field: 'body',
			meta: { field: 'body', translations: [{ language: 'de-DE', translation: 'Inhalt de-DE' }] },
		});

		fieldsStore.fields = [body].map(fieldsStore.parseField);
		expect(fieldsStore.fields[0].name).toEqual('Inhalt de-DE');

		const bodyWithoutTranslations = merge({}, mockField, {
			field: 'body',
			meta: { field: 'body', translations: null },
		});

		fieldsStore.fields = [bodyWithoutTranslations].map(fieldsStore.parseField);
		expect(fieldsStore.fields[0].name).toEqual('Body');
		expect(i18n.global.te(`fields.${mockField.collection}.body`)).toBe(false);
	});
});
