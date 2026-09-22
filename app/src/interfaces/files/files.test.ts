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
import Files from './files.vue';

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
				relation: {
					collection: 'a_directus_files',
					field: 'directus_files_id',
					related_collection: 'directus_files',
					meta: null,
					schema: null,
				},
				junction: {
					collection: 'a_directus_files',
					field: 'parent',
					related_collection: 'articles',
					meta: null,
					schema: null,
				},
				relatedCollection: {
					name: 'Files',
					collection: 'directus_files',
					icon: 'folder',
					meta: null,
					schema: null,
					type: 'table',
				},
				relatedPrimaryKeyField: {
					name: 'ID',
					collection: 'directus_files',
					field: 'id',
					type: 'uuid',
					meta: null,
					schema: null,
				},
				junctionCollection: {
					name: 'Attachments',
					collection: 'a_directus_files',
					icon: 'box',
					meta: null,
					schema: null,
					type: 'table',
				},
				junctionPrimaryKeyField: {
					name: 'ID',
					collection: 'a_directus_files',
					field: 'id',
					type: 'integer',
					meta: null,
					schema: null,
				},
				junctionField: {
					name: 'File',
					collection: 'a_directus_files',
					field: 'directus_files_id',
					type: 'uuid',
					meta: null,
					schema: null,
				},
				reverseJunctionField: {
					name: 'Parent',
					collection: 'a_directus_files',
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
vi.mock('@/utils/get-asset-url', () => ({ getAssetUrl: (path: string) => path }));

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

vi.mock('@/views/private/components/drawer-files.vue', () => ({
	default: { name: 'DrawerFilesStub', template: '<div />' },
}));

// eslint-disable-next-line vue/one-component-per-file
const Draggable = defineComponent({
	name: 'DraggableStub',
	props: { modelValue: { type: Array as () => any[], default: () => [] } },
	template:
		'<div><template v-for="(element, i) in modelValue" :key="i"><slot name="item" :element="element" /></template></div>',
});

// eslint-disable-next-line vue/one-component-per-file
const VListItem = defineComponent({
	name: 'VListItem',
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	methods: {
		onClick() {
			if (this.disabled) return;
			this.$emit('click');
		},
	},
	template: '<div class="v-list-item-stub" @click="onClick"><slot /></div>',
});

const passthrough = { template: '<div><slot /></div>' };

const stubs = {
	'v-list': passthrough,
	'v-list-item-icon': passthrough,
	'v-list-item-content': passthrough,
	'v-menu': passthrough,
	'v-card': passthrough,
	'v-card-title': passthrough,
	'v-card-text': passthrough,
	'v-card-actions': passthrough,
	'v-dialog': passthrough,
	'v-upload': { template: '<div />' },
	'v-icon': { props: ['name'], template: '<i :data-name="name" />' },
	'v-button': { template: '<button><slot /></button>' },
	'v-notice': passthrough,
	'v-skeleton-loader': { template: '<div />' },
	'v-pagination': { template: '<div />' },
	'render-template': { template: '<div />' },
};

function drawer(wrapper: ReturnType<typeof mountFiles>) {
	return wrapper.findComponent({ name: 'DrawerItemStub' });
}

function mountFiles(permissions: Permission[]) {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: false } };
	(usePermissionsStore() as any).permissions = permissions;

	return mount(Files, {
		props: { collection: 'articles', field: 'attachments', value: null, primaryKey: '1' },
		global: {
			plugins: [i18n, pinia],
			stubs,
			components: { draggable: Draggable, VListItem },
			directives: { tooltip: {} },
		},
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

const fileId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

beforeEach(() => {
	data.items = [
		{ id: 0, directus_files_id: { id: fileId, filename_download: 'a.png', type: 'image/png', title: 'A' } },
	];
});

describe('files row launch gate', () => {
	it('lets a junction-only role launch a file row with the correct keys', async () => {
		const wrapper = mountFiles([grant('a_directus_files', 'update')]);
		await flushPromises();

		await wrapper.find('.v-list-item-stub').trigger('click');

		const item = drawer(wrapper);
		expect(item.props('active')).toBe(true);
		expect(item.props('primaryKey')).toBe(0);
		expect(item.props('relatedPrimaryKey')).toBe(fileId);
	});

	it('forwards a later read-only state to the open drawer', async () => {
		const wrapper = mountFiles([grant('a_directus_files', 'update')]);
		await flushPromises();

		await wrapper.find('.v-list-item-stub').trigger('click');
		expect(drawer(wrapper).props('active')).toBe(true);

		await wrapper.setProps({ disabled: true });
		await flushPromises();

		expect(drawer(wrapper).props('disabled')).toBe(true);
	});

	it('does not launch for a role that cannot edit either target', async () => {
		const wrapper = mountFiles([]);
		await flushPromises();

		await wrapper.find('.v-list-item-stub').trigger('click');

		expect(drawer(wrapper).props('active')).toBe(false);
	});
});
