import { useAliasFields } from '@/composables/use-alias-fields';
import { createTestingPinia } from '@pinia/testing';
import { set } from 'lodash';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDisplayStringTemplate } from './render-string-template';

vi.mock('@/utils/adjust-fields-for-displays', () => ({
	adjustFieldsForDisplays: (fields: string[]) => fields,
}));

describe('renderDisplayStringTemplate', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn }));
	});

	it('resolves a display template field whose value was fetched under an aliased key', () => {
		const collection = 'articles';
		const template = '{{ author.name }} <{{ author.email }}>';

		const values: Record<string, string> = {
			'author.name': 'Ada Lovelace',
			'author.email': 'ada@example.com',
		};

		const { aliasedFields } = useAliasFields(Object.keys(values), collection);
		const item: Record<string, any> = {};

		for (const field of Object.values(aliasedFields.value)) {
			if (!field.aliased) continue;
			const leaf = field.key.split('.').slice(1).join('.');
			set(item, `${field.fieldAlias}.${leaf}`, values[field.key]);
		}

		expect(renderDisplayStringTemplate(collection, template, item)).toBe('Ada Lovelace <ada@example.com>');
	});
});
