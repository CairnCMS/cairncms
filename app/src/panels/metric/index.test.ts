import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import metric from './index';

describe('metric panel options', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it('uses typed defaults for the abbreviate and decimals options', () => {
		const optionFields = typeof metric.options === 'function' ? metric.options({ options: {} }) : metric.options ?? [];

		const abbreviate = optionFields.find((field) => field.field === 'abbreviate');
		const decimals = optionFields.find((field) => field.field === 'decimals');

		expect(abbreviate?.schema?.default_value).toBe(false);
		expect(decimals?.schema?.default_value).toBe(0);
	});
});
