import { i18n } from '@/lang';
import { RelationM2M } from '@/composables/use-relation-m2m';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { Permission } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import ListM2M from './list-m2m.vue';

enableAutoUnmount(afterEach);

const { data } = vi.hoisted(() => ({ data: { items: [] as any[] } }));

vi.mock('@/composables/use-relation-multiple', async () => {
	const { ref, computed } = await import('vue');
	return {
		useRelationMultiple: () => ({
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			select: vi.fn(),
			displayItems: computed(() => data.items),
			totalItemCount: computed(() => data.items.length),
			loading: ref(false),
			selected: ref([]),
			isItemSelected: () => false,
			isLocalItem: () => false,
			getItemEdits: () => ({}),
		}),
	};
});

vi.mock('@/composables/use-relation-m2m', async () => {
	const { ref } = await import('vue');
	return {
		useRelationM2M: () => ({
			relationInfo: ref<RelationM2M>({
				relation: { collection: 'a_b', field: 'item', related_collection: 'b', meta: null, schema: null },
				junction: { collection: 'a_b', field: 'parent', related_collection: 'a', meta: null, schema: null },
				relatedCollection: { name: 'B', collection: 'b', icon: 'box', meta: null, schema: null, type: 'table' },
				relatedPrimaryKeyField: { name: 'ID', collection: 'b', field: 'id', type: 'integer', meta: null, schema: null },
				junctionCollection: { name: 'A B', collection: 'a_b', icon: 'box', meta: null, schema: null, type: 'table' },
				junctionPrimaryKeyField: {
					name: 'ID',
					collection: 'a_b',
					field: 'id',
					type: 'integer',
					meta: null,
					schema: null,
				},
				junctionField: { name: 'Item', collection: 'a_b', field: 'item', type: 'integer', meta: null, schema: null },
				reverseJunctionField: {
					name: 'Parent',
					collection: 'a_b',
					field: 'parent',
					type: 'integer',
					meta: null,
					schema: null,
				},
				sortField: 'sort',
				type: 'm2m',
			}),
		}),
	};
});

vi.mock('@/utils/adjust-fields-for-displays', () => ({ adjustFieldsForDisplays: (fields: string[]) => fields }));

vi.mock('@/utils/add-related-primary-key-to-fields', () => ({
	addRelatedPrimaryKeyToFields: (fields: string[]) => fields,
}));

vi.mock('@/views/private/components/drawer-item.vue', () => ({
	default: {
		name: 'DrawerItemStub',
		props: {
			active: { type: Boolean, default: false },
			disabled: { type: Boolean, default: false },
			primaryKey: { type: [String, Number], default: undefined },
			relatedPrimaryKey: { type: [String, Number], default: undefined },
		},
		emits: ['update:active', 'input'],
		template: '<div class="drawer-item-stub" />',
	},
}));

vi.mock('@/views/private/components/drawer-collection.vue', () => ({
	default: { name: 'DrawerCollectionStub', template: '<div />' },
}));

vi.mock('@/views/private/components/search-input.vue', () => ({
	default: { name: 'SearchInputStub', template: '<div />' },
}));

// eslint-disable-next-line vue/one-component-per-file
const VTable = defineComponent({
	name: 'VTable',
	props: {
		disabled: { type: Boolean, default: false },
		showManualSort: { type: Boolean, default: false },
		items: { type: Array as () => any[], default: () => [] },
	},
	emits: ['click:row', 'update:items', 'update:sort', 'update:headers'],
	methods: {
		launch(item: any) {
			if (this.disabled) return;
			this.$emit('click:row', { item });
		},
	},
	template:
		'<div class="v-table-stub"><button v-for="(item, i) in items" :key="i" class="row" @click="launch(item)" /></div>',
});

const stubs = {
	'v-menu': { template: '<div><slot name="activator" :toggle="() => {}" /><slot /></div>' },
	'v-button': { template: '<button><slot /></button>' },
	'v-icon': { props: ['name'], template: '<i :data-name="name" />' },
	'v-list': { template: '<div><slot /></div>' },
	'v-list-item': { template: '<div><slot /></div>' },
	'v-notice': { template: '<div><slot /></div>' },
	'v-info': { template: '<div><slot /></div>' },
	'v-skeleton-loader': { template: '<div />' },
	'v-pagination': { template: '<div />' },
	'v-select': { template: '<div />' },
	'render-template': { template: '<div />' },
	'router-link': { template: '<a><slot /></a>' },
	draggable: { template: '<div><slot /></div>' },
};

function drawer(wrapper: ReturnType<typeof mountList>) {
	return wrapper.findComponent({ name: 'DrawerItemStub' });
}

function table(wrapper: ReturnType<typeof mountList>) {
	return wrapper.findComponent(VTable);
}

function mountList(permissions: Permission[]) {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: false } };
	(usePermissionsStore() as any).permissions = permissions;

	return mount(ListM2M, {
		props: {
			collection: 'articles',
			field: 'categories',
			value: null,
			primaryKey: '1',
			width: 'full',
			layout: 'table',
		},
		global: { plugins: [i18n, pinia], stubs, components: { VTable }, directives: { tooltip: {} } },
	});
}

const grant = (collection: string, action: Permission['action']): Permission => ({
	role: 'role-1',
	collection,
	action,
	permissions: {},
	validation: null,
	presets: null,
	fields: ['*'],
});

beforeEach(() => {
	data.items = [{ id: 0, item: { id: 3 } }];
});

describe('list-m2m launch and reorder gates', () => {
	it('lets a junction-only role launch a populated row with the correct keys', async () => {
		const wrapper = mountList([grant('a_b', 'update')]);
		await flushPromises();

		expect(table(wrapper).props('disabled')).toBe(false);

		await wrapper.find('.v-table-stub .row').trigger('click');

		const item = drawer(wrapper);
		expect(item.props('active')).toBe(true);
		expect(item.props('primaryKey')).toBe(0);
		expect(item.props('relatedPrimaryKey')).toBe(3);
	});

	it('lets a related-only role launch but not reorder', async () => {
		const wrapper = mountList([grant('b', 'update')]);
		await flushPromises();

		expect(table(wrapper).props('disabled')).toBe(false);
		expect(table(wrapper).props('showManualSort')).toBe(false);
	});

	it('allows reordering only with junction update permission', async () => {
		const wrapper = mountList([grant('a_b', 'update')]);
		await flushPromises();

		expect(table(wrapper).props('showManualSort')).toBe(true);
	});

	it('disables the table launch control when no target is editable', async () => {
		const wrapper = mountList([]);
		await flushPromises();

		expect(table(wrapper).props('disabled')).toBe(true);
	});
});
