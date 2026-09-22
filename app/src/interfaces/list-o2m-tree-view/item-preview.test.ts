import { i18n } from '@/lang';
import { RelationO2M } from '@/composables/use-relation-o2m';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ItemPreview from './item-preview.vue';

enableAutoUnmount(afterEach);

vi.mock('@/views/private/components/drawer-item.vue', () => ({
	default: {
		name: 'DrawerItemStub',
		props: {
			active: { type: Boolean, default: false },
			disabled: { type: Boolean, default: false },
			collection: { type: String, default: '' },
			primaryKey: { type: [String, Number], default: undefined },
		},
		emits: ['update:active', 'input'],
		template: '<div class="drawer-item-stub" />',
	},
}));

const relationInfo: RelationO2M = {
	relatedCollection: { name: 'Pages', collection: 'pages', icon: 'article', meta: null, schema: null, type: 'table' },
	relatedPrimaryKeyField: { name: 'ID', collection: 'pages', field: 'id', type: 'integer', meta: null, schema: null },
	reverseJunctionField: {
		name: 'Parent',
		collection: 'pages',
		field: 'parent',
		type: 'integer',
		meta: null,
		schema: null,
	},
	relation: { collection: 'pages', field: 'parent', related_collection: 'pages', meta: null, schema: null },
	type: 'o2m',
};

const stubs = {
	'v-icon': { props: ['name'], emits: ['click'], template: '<i :data-name="name" @click="$emit(\'click\')" />' },
	'render-template': { template: '<div />' },
};

function drawer(wrapper: ReturnType<typeof mountPreview>) {
	return wrapper.findComponent({ name: 'DrawerItemStub' });
}

function mountPreview(props: Record<string, any> = {}) {
	return mount(ItemPreview, {
		props: {
			collection: 'pages',
			template: '{{ id }}',
			item: { id: 0 },
			edits: {},
			relationInfo,
			deleted: false,
			deleteIcon: 'close',
			...props,
		},
		global: { plugins: [i18n], stubs, directives: { tooltip: {} } },
	});
}

describe('tree-view item-preview drawer binding', () => {
	it('passes a numeric key of 0 to the drawer, not the new marker', () => {
		const wrapper = mountPreview({ item: { id: 0 } });
		expect(drawer(wrapper).props('primaryKey')).toBe(0);
	});

	it('forwards a later read-only state to an already-open drawer', async () => {
		const wrapper = mountPreview({ item: { id: 5 }, disabled: false });

		await wrapper.find('[data-name="launch"]').trigger('click');
		expect(drawer(wrapper).props('active')).toBe(true);

		await wrapper.setProps({ disabled: true });
		await flushPromises();

		expect(drawer(wrapper).props('disabled')).toBe(true);
	});
});
