import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createI18n } from 'vue-i18n';

vi.mock('@/composables/use-extension', () => ({
	useExtension: () => ref({ id: 'input' }),
}));

import FormFieldInterface from './form-field-interface.vue';

const i18n = createI18n({ legacy: false });

function makeField(overrides: Record<string, any> = {}) {
	const { meta = {}, schema = {}, ...rest } = overrides;

	return {
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
			...meta,
		},
		schema: {
			name: 'title',
			table: 'test',
			data_type: 'varchar',
			...schema,
		},
		...rest,
	};
}

const interfaceInputStub = {
	name: 'interface-input',
	template: '<div class="interface-input-stub" />',
	props: ['value'],
};

const rawEditorStub = {
	name: 'interface-system-raw-editor',
	template: '<div class="interface-system-raw-editor-stub" />',
	props: ['value'],
};

const baseStubs = {
	'v-error-boundary': { template: '<div><slot /></div>' },
	'v-skeleton-loader': true,
	'v-notice': true,
	'interface-input': interfaceInputStub,
	'interface-system-raw-editor': rawEditorStub,
};

function mountField(props: Record<string, any>) {
	return mount(FormFieldInterface, {
		props,
		global: {
			plugins: [i18n],
			stubs: baseStubs,
		},
	});
}

describe('FormFieldInterface normalizes the value passed to the rendered interface', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn }));
	});

	it('resolves to null when modelValue is omitted and the schema has no default_value', () => {
		const wrapper = mountField({ field: makeField() });

		const child = wrapper.findComponent(interfaceInputStub);
		expect(child.exists()).toBe(true);
		expect(child.props('value')).toBeNull();
	});

	it('passes a falsy zero default_value through unchanged', () => {
		const wrapper = mountField({
			field: makeField({ schema: { default_value: 0 } }),
		});

		expect(wrapper.findComponent(interfaceInputStub).props('value')).toBe(0);
	});

	it('passes a falsy false default_value through unchanged', () => {
		const wrapper = mountField({
			field: makeField({ schema: { default_value: false } }),
		});

		expect(wrapper.findComponent(interfaceInputStub).props('value')).toBe(false);
	});

	it('passes a falsy empty-string default_value through unchanged', () => {
		const wrapper = mountField({
			field: makeField({ schema: { default_value: '' } }),
		});

		expect(wrapper.findComponent(interfaceInputStub).props('value')).toBe('');
	});

	it('passes an explicit null modelValue through unchanged', () => {
		const wrapper = mountField({
			field: makeField({ schema: { default_value: 'fallback' } }),
			modelValue: null,
		});

		expect(wrapper.findComponent(interfaceInputStub).props('value')).toBeNull();
	});

	it('passes an explicit modelValue through unchanged regardless of default_value', () => {
		const wrapper = mountField({
			field: makeField({ schema: { default_value: 'fallback' } }),
			modelValue: 'operator-set',
		});

		expect(wrapper.findComponent(interfaceInputStub).props('value')).toBe('operator-set');
	});

	it('routes the raw editor branch through the original inline expression, leaving the value undefined when neither modelValue nor default_value is set', () => {
		const wrapper = mountField({
			field: makeField(),
			rawEditorEnabled: true,
			rawEditorActive: true,
		});

		const child = wrapper.findComponent(rawEditorStub);
		expect(child.exists()).toBe(true);
		expect(child.props('value')).toBeUndefined();
	});
});
