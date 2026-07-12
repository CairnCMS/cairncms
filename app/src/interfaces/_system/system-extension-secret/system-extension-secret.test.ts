import { i18n } from '@/lang';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import InterfaceSystemExtensionSecret from './system-extension-secret.vue';

const stubs = {
	'v-input': {
		name: 'v-input',
		props: ['modelValue', 'placeholder', 'type'],
		emits: ['update:modelValue'],
		template: '<div class="v-input" :data-placeholder="placeholder"><slot name="append" /></div>',
	},
	'v-icon': { props: ['name'], template: '<i :data-name="name"></i>' },
};

function mountSecret(value: string | null) {
	return mount(InterfaceSystemExtensionSecret, {
		props: { value },
		global: { plugins: [i18n], stubs },
	});
}

describe('system-extension-secret', () => {
	it('shows the saved-state placeholder and lock for a stored secret, never the sentinel as a value', () => {
		const wrapper = mountSecret('**********');

		const input = wrapper.findComponent({ name: 'v-input' });
		expect(input.props('modelValue')).toBeNull();
		expect(input.props('placeholder')).toBe('Value Securely Encrypted');
		expect(wrapper.find('i[data-name="lock"]').exists()).toBe(true);
	});

	it('shows an open lock and no saved-state placeholder when nothing is stored', () => {
		const wrapper = mountSecret(null);

		expect(wrapper.findComponent({ name: 'v-input' }).props('placeholder')).toBeUndefined();
		expect(wrapper.find('i[data-name="lock_open"]').exists()).toBe(true);
	});

	it('emits a typed replacement and null for an emptied input', async () => {
		const wrapper = mountSecret('**********');

		const input = wrapper.findComponent({ name: 'v-input' });

		input.vm.$emit('update:modelValue', 'sk_live_new');
		expect(wrapper.emitted('input')?.at(-1)).toEqual(['sk_live_new']);

		input.vm.$emit('update:modelValue', '');
		expect(wrapper.emitted('input')?.at(-1)).toEqual([null]);
	});
});
