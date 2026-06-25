import { i18n } from '@/lang';
import { useCollectionsStore } from '@/stores/collections';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CollectionOptions from './collection-options.vue';

const stubs = {
	'v-menu': { template: '<div><slot /></div>' },
	'v-list': { template: '<div><slot /></div>' },
	'v-list-item': { template: '<div class="v-list-item" @click="$emit(\'click\')"><slot /></div>', emits: ['click'] },
	'v-list-item-icon': { template: '<div><slot /></div>' },
	'v-list-item-content': { template: '<div class="v-list-item-content"><slot /></div>' },
	'v-icon': { props: ['name'], template: '<i :data-icon="name"></i>' },
	'v-divider': true,
	'v-dialog': true,
	'v-card': true,
	'v-card-title': true,
	'v-card-text': true,
	'v-card-actions': true,
	'v-button': true,
	'v-notice': true,
};

function mountOptions(collection: Record<string, unknown>, hasNestedCollections: boolean) {
	return mount(CollectionOptions, {
		props: { collection, hasNestedCollections } as never,
		global: { plugins: [i18n], stubs },
	});
}

function collapseItem(wrapper: ReturnType<typeof mountOptions>, label: string) {
	return wrapper.findAll('.v-list-item').find((item) => item.text().includes(label));
}

describe('collection-options collapse settings', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn }));
	});

	it('shows the three collapse settings for a collection with nested collections', () => {
		const wrapper = mountOptions({ collection: 'articles', type: 'normal', schema: {}, meta: {} }, true);

		expect(collapseItem(wrapper, 'Start Open')).toBeTruthy();
		expect(collapseItem(wrapper, 'Start Collapsed')).toBeTruthy();
		expect(collapseItem(wrapper, 'Always Open')).toBeTruthy();
	});

	it('shows the collapse settings for an alias collection even without nested collections', () => {
		const wrapper = mountOptions({ collection: 'group', type: 'alias', meta: {} }, false);

		expect(collapseItem(wrapper, 'Start Open')).toBeTruthy();
	});

	it('hides the collapse settings for a leaf collection with no nested collections', () => {
		const wrapper = mountOptions({ collection: 'articles', type: 'normal', schema: {}, meta: {} }, false);

		expect(collapseItem(wrapper, 'Start Open')).toBeFalsy();
		expect(collapseItem(wrapper, 'Always Open')).toBeFalsy();
	});

	it('writes the matching meta.collapse value for each setting', async () => {
		const wrapper = mountOptions({ collection: 'articles', type: 'normal', schema: {}, meta: {} }, true);
		const store = useCollectionsStore();

		await collapseItem(wrapper, 'Start Open')!.trigger('click');
		expect(store.updateCollection).toHaveBeenCalledWith('articles', { meta: { collapse: 'open' } });

		await collapseItem(wrapper, 'Start Collapsed')!.trigger('click');
		expect(store.updateCollection).toHaveBeenCalledWith('articles', { meta: { collapse: 'closed' } });

		await collapseItem(wrapper, 'Always Open')!.trigger('click');
		expect(store.updateCollection).toHaveBeenCalledWith('articles', { meta: { collapse: 'locked' } });
	});
});
