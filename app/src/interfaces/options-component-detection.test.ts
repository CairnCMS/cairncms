import { isVueComponent } from '@cairncms/utils';
import { describe, expect, it } from 'vitest';
import ListOptions from './list/options.vue';
import MapOptions from './map/options.vue';

describe('options component detection', () => {
	it('treats the list and map options SFCs as Vue components', () => {
		expect(isVueComponent(ListOptions)).toBe(true);
		expect(isVueComponent(MapOptions)).toBe(true);
	});

	it('treats plain option-field shapes as non-components', () => {
		expect(isVueComponent({ field: 'example' })).toBe(false);
		expect(isVueComponent([{ field: 'example' }])).toBe(false);
	});
});
