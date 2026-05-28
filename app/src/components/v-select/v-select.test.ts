import { test, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import VSelect from './v-select.vue';
import { GlobalMountOptions } from '@vue/test-utils/dist/types';
import { createI18n } from 'vue-i18n';
import { Focus } from '@/__utils__/focus';

const i18n = createI18n({ legacy: false });

const global: GlobalMountOptions = {
	stubs: [
		'v-list',
		'v-list-item',
		'v-list-item-icon',
		'v-list-item-content',
		'v-divider',
		'v-checkbox',
		'v-menu',
		'v-icon',
		'v-input',
	],
	plugins: [i18n],
	directives: {
		Focus,
	},
};

const items = [
	{
		text: 'Item 1',
		value: 'item1',
	},
	{
		text: 'Item 2',
		value: 'item2',
	},
	{
		text: 'Item 3',
		value: 'item3',
	},
];

test('Mount component', () => {
	expect(VSelect).toBeTruthy();

	const wrapper = mount(VSelect, {
		props: {
			items,
		},
		global,
	});

	expect(wrapper.html()).toMatchSnapshot();
});

test('Resolves a numeric scalar modelValue to the matching item text without a modelValue prop warning', () => {
	const numericItems = [
		{ text: 'Thin', value: 8 },
		{ text: 'Medium', value: 20 },
		{ text: 'Broad', value: 48 },
	];

	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

	const slotAwareGlobal: GlobalMountOptions = {
		...global,
		stubs: {
			'v-list': true,
			'v-list-item': true,
			'v-list-item-icon': true,
			'v-list-item-content': true,
			'v-divider': true,
			'v-checkbox': true,
			'v-icon': true,
			'v-input': true,
			'v-menu': {
				name: 'v-menu',
				template:
					'<div><slot name="activator" :toggle="() => {}" :active="false" :deactivate="() => {}" /><slot /></div>',
			},
		},
	};

	try {
		const wrapper = mount(VSelect, {
			props: {
				items: numericItems,
				modelValue: 20,
			},
			global: slotAwareGlobal,
		});

		expect(wrapper.exists()).toBe(true);

		const modelValueWarnings = warnSpy.mock.calls
			.flatMap((call) => call.map(String))
			.filter((message) => message.includes('modelValue'));

		expect(modelValueWarnings).toEqual([]);

		const previewInput = wrapper.find('v-input-stub');
		expect(previewInput.exists()).toBe(true);
		expect(previewInput.attributes('model-value')).toBe('Medium');
	} finally {
		warnSpy.mockRestore();
	}
});
