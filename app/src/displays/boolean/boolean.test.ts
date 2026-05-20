import { mount } from '@vue/test-utils';
import { GlobalMountOptions } from '@vue/test-utils/dist/types';
import { expect, test } from 'vitest';

import BooleanDisplay from './boolean.vue';

const global: GlobalMountOptions = {
	stubs: ['v-icon', 'value-null'],
};

test('renders the default on icon when no icon is configured', () => {
	const wrapper = mount(BooleanDisplay, {
		props: { value: true, colorOn: 'var(--primary)', colorOff: 'var(--foreground-subdued)' },
		global,
	});

	expect(wrapper.find('v-icon-stub').attributes('name')).toBe('check');
});

test('renders the default off icon when no icon is configured', () => {
	const wrapper = mount(BooleanDisplay, {
		props: { value: false, colorOn: 'var(--primary)', colorOff: 'var(--foreground-subdued)' },
		global,
	});

	expect(wrapper.find('v-icon-stub').attributes('name')).toBe('close');
});
