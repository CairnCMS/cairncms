import { i18n } from '@/lang';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CollectionDialog from './collection-dialog.vue';

const interfaceListStub = {
	name: 'interface-list',
	props: ['fields', 'value', 'template'],
	template: '<div class="interface-list-stub" />',
};

const stubs = {
	'v-dialog': { template: '<div><slot /></div>' },
	'v-card': { template: '<div><slot /></div>' },
	'v-card-title': true,
	'v-card-text': { template: '<div><slot /></div>' },
	'v-card-actions': true,
	'v-input': true,
	'v-button': true,
	'interface-select-icon': true,
	'interface-select-color': true,
	'interface-list': interfaceListStub,
};

function mountDialog() {
	return mount(CollectionDialog, {
		props: { modelValue: true } as never,
		global: { plugins: [i18n], stubs },
	});
}

describe('collection-dialog translation field names', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn }));
	});

	it('passes translated, formatTitle-stable field names to the translations repeater', () => {
		const wrapper = mountDialog();
		const fields = wrapper.findComponent('.interface-list-stub').props('fields') as { field: string; name: string }[];

		const byField = Object.fromEntries(fields.map((field) => [field.field, field.name]));
		expect(byField['language']).toBe('Language');
		expect(byField['translation']).toBe('Collection Name');

		for (const field of fields) {
			expect(field.name.startsWith('$t:')).toBe(false);
			expect(field.name).not.toContain('field Options.directus');
		}
	});
});
