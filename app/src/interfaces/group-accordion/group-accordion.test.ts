import type { Field } from '@cairncms/types';
import { mount } from '@vue/test-utils';
import { expect, test } from 'vitest';
import AccordionSection from './accordion-section.vue';
import GroupAccordion from './group-accordion.vue';

const global = {
	stubs: {
		VItemGroup: { template: '<div><slot /></div>' },
		AccordionSection: true,
	},
};

const groupField = {
	field: 'mygroup',
	name: 'My Group',
	type: 'alias',
	meta: { field: 'mygroup', group: null },
} as unknown as Field;

const childField = {
	field: 'child',
	name: 'Child',
	type: 'string',
	meta: { field: 'child', group: 'mygroup' },
} as unknown as Field;

function mountAccordion(values: Record<string, unknown>) {
	return mount(GroupAccordion, {
		props: {
			field: groupField,
			fields: [groupField, childField],
			values,
			initialValues: {},
			primaryKey: '+',
		},
		global,
	});
}

test('seeds group values from the incoming values on the initial render', () => {
	const wrapper = mountAccordion({ child: 'hello' });

	const section = wrapper.findComponent(AccordionSection);
	expect(section.exists()).toBe(true);
	// Read on the first render, before any prop change: proves the initial seed, not the watcher.
	expect(section.props('values')).toEqual({ child: 'hello' });
});

test('keeps syncing group values when the incoming values change', async () => {
	const wrapper = mountAccordion({ child: 'hello' });

	await wrapper.setProps({ values: { child: 'world' } });

	const section = wrapper.findComponent(AccordionSection);
	expect(section.props('values')).toEqual({ child: 'world' });
});
