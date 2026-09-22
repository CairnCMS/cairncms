import { i18n } from '@/lang';
import { FieldFilter } from '@cairncms/types';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import InputComponent from './input-component.vue';
import InputGroup from './input-group.vue';

const stubs = {
	'v-menu': true,
	'v-icon': true,
	'v-select': true,
	'v-date-picker': true,
};

function mountGroup(field: FieldFilter) {
	return mount(InputGroup, {
		props: { field, collection: 'articles' },
		global: { plugins: [i18n], stubs },
	});
}

function boundValues(wrapper: ReturnType<typeof mountGroup>) {
	return wrapper.findAllComponents(InputComponent).map((component) => component.props('value'));
}

describe('Between filter input bindings', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it('binds each bound to its own input for _between', () => {
		const wrapper = mountGroup({ amount: { _between: [10, 20] } });
		expect(boundValues(wrapper)).toEqual([10, 20]);
	});

	it('renders an empty string for an absent bound in _nbetween', () => {
		const wrapper = mountGroup({ amount: { _nbetween: [10] } });
		expect(boundValues(wrapper)).toEqual([10, '']);
	});

	it('preserves the other bound when one is edited and emits the same nested filter shape', () => {
		const wrapper = mountGroup({ amount: { _between: [10, 20] } });
		wrapper.findAllComponents(InputComponent)[0]!.vm.$emit('input', 15);
		expect(wrapper.emitted('update:field')?.at(-1)).toEqual([{ amount: { _between: [15, 20] } }]);
	});
});
