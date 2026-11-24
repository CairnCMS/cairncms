import { i18n } from '@/lang';
import type { ValidationError } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { shallowMount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FormField from './form-field.vue';

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

function mountField(validationError: ValidationError) {
	return shallowMount(FormField, {
		props: { field: field as any, validationError },
		global: { plugins: [i18n], directives: { md: {}, tooltip: {} } },
	});
}

describe('FormField validation message', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn }));
	});

	it('shows a failed validation message without the compared value', () => {
		const wrapper = mountField({
			code: 'FAILED_VALIDATION',
			collection: 'test',
			field: 'title',
			type: 'eq',
			group: null,
			valid: 'SECRET_OPERAND',
		} as unknown as ValidationError);

		expect(wrapper.find('.validation-error').text()).toBe('Value has to be the required value');
	});

	it('shows the unique message for a duplicate value', () => {
		const wrapper = mountField({ code: 'RECORD_NOT_UNIQUE', collection: 'test', field: 'title', group: null });

		expect(wrapper.find('.validation-error').text()).toBe('Value has to be unique');
	});
});
