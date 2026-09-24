import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import { defineComponent, ref } from 'vue';

const CUSTOM_MARKER = { __isCustom: true };

const extensionInfo = ref<{ id: string; options: unknown }>({ id: 'metric', options: [] });

vi.mock('@/composables/use-extension', () => ({ useExtension: () => extensionInfo }));

vi.mock('../store', () => ({
	useFieldDetailStore: () => ({ collection: ref('directus_panels'), field: ref('options') }),
}));

vi.mock('@cairncms/utils', () => ({
	isVueComponent: (value: unknown) => !!value && typeof value === 'object' && (value as any).__isCustom === true,
}));

import ExtensionOptions from './extension-options.vue';

const i18n = createI18n({ legacy: false });

// eslint-disable-next-line vue/one-component-per-file
const VForm = defineComponent({
	name: 'VForm',
	props: { disabled: { type: Boolean, default: false }, fields: { type: Array, default: () => [] } },
	emits: ['update:modelValue'],
	template: '<div class="v-form-stub" />',
});

// eslint-disable-next-line vue/one-component-per-file
const CustomOptions = defineComponent({
	name: 'PanelOptionsMetric',
	props: { value: { type: Object, default: () => ({}) }, disabled: { type: Boolean, default: false } },
	emits: ['input'],
	template: '<div class="custom-options-stub" />',
});

const VErrorBoundary = { template: '<div><slot /></div>' };

function mountOptions(disabled: boolean, custom: boolean, optionsFields: unknown[] = []) {
	extensionInfo.value = { id: 'metric', options: custom ? CUSTOM_MARKER : optionsFields };

	return mount(ExtensionOptions, {
		props: { type: 'panel', extension: 'metric', modelValue: { existing: true }, disabled, options: optionsFields },
		global: {
			plugins: [i18n],
			components: { 'panel-options-metric': CustomOptions },
			stubs: {
				'v-form': VForm,
				'v-error-boundary': VErrorBoundary,
				'v-notice': { template: '<div><slot /></div>' },
			},
		},
	});
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('extension-options disabled enforcement', () => {
	it('forwards disabled to the generated form and drops its emitted changes', async () => {
		const wrapper = mountOptions(true, false, [{ field: 'a', type: 'string', meta: {}, name: 'A' }]);
		await flushPromises();

		expect(wrapper.findComponent(VForm).props('disabled')).toBe(true);

		wrapper.findComponent(VForm).vm.$emit('update:modelValue', { changed: true });
		await flushPromises();

		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});

	it('drops changes emitted by a disabled custom component', async () => {
		const wrapper = mountOptions(true, true);
		await flushPromises();

		expect(wrapper.find('.custom-options-stub').exists()).toBe(true);
		expect(wrapper.findComponent(CustomOptions).props('disabled')).toBe(true);

		wrapper.findComponent(CustomOptions).vm.$emit('input', { changed: true });
		await flushPromises();

		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});

	it('emits changes from an enabled custom component', async () => {
		const wrapper = mountOptions(false, true);
		await flushPromises();

		expect(wrapper.findComponent(CustomOptions).props('disabled')).toBe(false);

		wrapper.findComponent(CustomOptions).vm.$emit('input', { changed: true });
		await flushPromises();

		expect(wrapper.emitted('update:modelValue')).toEqual([[{ changed: true }]]);
	});

	it('marks the custom component subtree inert while disabled', async () => {
		const disabled = mountOptions(true, true);
		await flushPromises();
		expect(disabled.findComponent(CustomOptions).element.parentElement?.hasAttribute('inert')).toBe(true);

		const enabled = mountOptions(false, true);
		await flushPromises();
		expect(enabled.findComponent(CustomOptions).element.parentElement?.hasAttribute('inert')).toBe(false);
	});
});
