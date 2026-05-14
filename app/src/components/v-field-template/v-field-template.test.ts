import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import VFieldTemplate from './v-field-template.vue';

vi.mock('@/stores/fields', () => ({
	useFieldsStore: () => ({
		getFieldsForCollection: () => [],
		getFieldsForCollectionSorted: () => [],
		getField: () => null,
	}),
}));

vi.mock('@/stores/relations', () => ({
	useRelationsStore: () => ({
		getRelationsForField: () => [],
		getRelationsForCollection: () => [],
	}),
}));

const globalStubs = {
	VMenu: {
		template: '<div><slot name="activator" :toggle="() => {}" /><slot /></div>',
	},
	VInput: {
		template: '<div><slot name="input" /><slot name="append" /></div>',
	},
	VList: {
		template: '<div><slot /></div>',
	},
	VIcon: { template: '<i />' },
	FieldListItem: { template: '<div />' },
};

function makeField(field: string, name: string) {
	return {
		field,
		name,
		collection: 'probe',
		type: 'string',
		meta: null,
		schema: null,
	} as any;
}

function mountWithInject(modelValue: string | null, fields: any[] = []) {
	return mount(VFieldTemplate, {
		props: {
			modelValue,
			collection: 'probe',
			inject: { fields, relations: [] },
		},
		global: { stubs: globalStubs },
	});
}

describe('v-field-template — XSS (GHSA-9qrm-48qf-r2rw)', () => {
	it('renders <iframe> in stored template as text, not as an iframe element', () => {
		const malicious = '<iframe srcdoc="alert(1)"></iframe>';
		const wrapper = mountWithInject(malicious);

		expect(wrapper.find('.content iframe').exists()).toBe(false);
		expect(wrapper.find('.content').text()).toBe(malicious);
	});

	it('renders <script> in stored template as text, not as a script element', () => {
		const malicious = '<script>alert(1)</script>';
		const wrapper = mountWithInject(malicious);

		expect(wrapper.find('.content script').exists()).toBe(false);
		expect(wrapper.find('.content').text()).toBe(malicious);
	});

	it('renders <img onerror=...> as text, not as a live element', () => {
		const malicious = '<img src=x onerror=alert(1)>';
		const wrapper = mountWithInject(malicious);

		expect(wrapper.find('.content img').exists()).toBe(false);
		expect(wrapper.find('.content').text()).toBe(malicious);
	});
});

describe('v-field-template — template shape and round-trip', () => {
	it('renders mixed literal and placeholder parts with the expected DOM shape', () => {
		const wrapper = mountWithInject('Hello {{name}} <world>', [makeField('name', 'Name')]);

		const spans = wrapper.findAll('.content span.text');
		const buttons = wrapper.findAll('.content button[data-field="name"]');

		expect(spans).toHaveLength(2);
		expect(spans[0]!.element.textContent).toBe('Hello ');
		expect(spans[1]!.element.textContent).toBe(' <world>');
		expect(buttons).toHaveLength(1);
		expect(buttons[0]!.element.textContent).toBe('Name');
	});

	it('round-trips a mixed template via an input event back to the original modelValue', async () => {
		const wrapper = mountWithInject('Hello {{name}} <world>', [makeField('name', 'Name')]);

		await wrapper.find('.content').trigger('input');

		const emitted = wrapper.emitted('update:modelValue');
		expect(emitted).toBeTruthy();
		expect(emitted![emitted!.length - 1]).toEqual(['Hello {{name}} <world>']);
	});

	it('renders an empty model value as a single empty .text span', () => {
		const wrapper = mountWithInject('');

		const spans = wrapper.findAll('.content span.text');
		const buttons = wrapper.findAll('.content button');

		expect(spans).toHaveLength(1);
		expect(spans[0]!.text()).toBe('');
		expect(buttons).toHaveLength(0);
	});

	it('renders multiple placeholders as one button each', () => {
		const wrapper = mountWithInject('{{first_name}} {{last_name}}', [
			makeField('first_name', 'First Name'),
			makeField('last_name', 'Last Name'),
		]);

		const buttons = wrapper.findAll('.content button[data-field]');
		expect(buttons).toHaveLength(2);
		expect(buttons[0]!.attributes('data-field')).toBe('first_name');
		expect(buttons[0]!.text()).toBe('First Name');
		expect(buttons[1]!.attributes('data-field')).toBe('last_name');
		expect(buttons[1]!.text()).toBe('Last Name');
	});
});
