import { i18n } from '@/lang';
import { createTestingPinia } from '@pinia/testing';
import { shallowMount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FormField from './form-field.vue';
import VForm from './v-form.vue';

const field = {
	collection: 'test',
	field: 'title',
	type: 'string',
	name: 'Title',
	meta: {
		collection: 'test',
		field: 'title',
		type: 'string',
		interface: 'input',
		special: null,
		hidden: false,
		group: null,
		sort: 1,
		width: 'full',
	},
	schema: { name: 'title', table: 'test', data_type: 'varchar' },
};

function mountForm(loading: boolean) {
	return shallowMount(VForm, {
		props: { fields: [field] as any, loading },
		global: { plugins: [i18n] },
	});
}

describe('VForm renders a field only when it is present in fieldsMap', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn }));
	});

	it('does not render a form field while loading, when fieldsMap is empty', () => {
		const wrapper = mountForm(true);

		expect(wrapper.findComponent(FormField).exists()).toBe(false);
	});

	it('renders the form field once loading is complete and the field is in fieldsMap', () => {
		const wrapper = mountForm(false);

		expect(wrapper.findComponent(FormField).exists()).toBe(true);
	});
});
