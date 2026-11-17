import { i18n } from '@/lang';
import type { Field, ValidationError } from '@cairncms/types';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ValidationErrors from './validation-errors.vue';

function titleField(validationMessage: string | null = null) {
	return {
		collection: 'articles',
		field: 'title',
		name: 'Title',
		type: 'string',
		meta: { collection: 'articles', field: 'title', validation_message: validationMessage, hidden: false, group: null },
		schema: null,
	} as unknown as Field;
}

const failure = {
	code: 'FAILED_VALIDATION',
	field: 'title',
	type: 'eq',
	group: null,
	valid: 'SECRET_OPERAND',
} as unknown as ValidationError;

function mountErrors(fields: Field[]) {
	return mount(ValidationErrors, {
		props: { validationErrors: [failure], fields },
		global: {
			plugins: [i18n],
			stubs: { 'v-notice': { template: '<div><slot /></div>' }, 'v-icon': { template: '<i />' } },
			directives: {
				tooltip: {
					mounted(el: HTMLElement, binding: { value: string }) {
						el.setAttribute('data-tooltip', binding.value);
					},
				},
			},
		},
	});
}

describe('ValidationErrors', () => {
	it('lists the field with its validation message and no compared value', () => {
		const text = mountErrors([titleField()]).text();

		expect(text).toContain('Title');
		expect(text).toContain('Value has to be the required value');
		expect(text).not.toContain('SECRET_OPERAND');
	});

	it('shows a custom validation message, with the generated message in its tooltip', () => {
		const wrapper = mountErrors([titleField('Use the code from your contract')]);

		expect(wrapper.text()).toContain('Use the code from your contract');
		expect(wrapper.find('[data-tooltip]').attributes('data-tooltip')).toBe('Value has to be the required value');
	});
});
