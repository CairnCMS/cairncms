// @vitest-environment happy-dom
import { ITEM_VIEW_CONTEXT_INJECT } from '@cairncms/constants';
import type { ItemViewContext } from '@cairncms/types';
import { mount } from '@vue/test-utils';
import { expect, test } from 'vitest';
import { computed, defineComponent, ref } from 'vue';
import { useItemViewContext } from './use-item-view-context.js';

function makeContext(): ItemViewContext {
	return {
		collection: ref('articles'),
		primaryKey: ref<string | null>('1'),
		collectionInfo: ref(null),
		isNew: ref(false),
		item: ref(null),
		onSaved: () => undefined,
		settings: { get: async () => null },
	} as ItemViewContext;
}

const Probe = defineComponent({
	setup() {
		const context = useItemViewContext();
		return { collection: context.collection };
	},
	template: '<div>{{ collection }}</div>',
});

test('returns the provided context', () => {
	const context = makeContext();

	const wrapper = mount(Probe, {
		global: { provide: { [ITEM_VIEW_CONTEXT_INJECT]: computed(() => context) } },
	});

	expect(wrapper.text()).toBe('articles');
});

test('throws outside an item view pane', () => {
	expect(() => mount(Probe)).toThrowError('[useItemViewContext]');
});

test('throws when no pane is active', () => {
	expect(() =>
		mount(Probe, {
			global: { provide: { [ITEM_VIEW_CONTEXT_INJECT]: computed(() => null) } },
		})
	).toThrowError('[useItemViewContext]');
});
