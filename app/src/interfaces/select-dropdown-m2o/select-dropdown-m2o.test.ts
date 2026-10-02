import { i18n } from '@/lang';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { RelationM2O } from '@/composables/use-relation-m2o';
import { Permission } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import SelectDropdownM2O from './select-dropdown-m2o.vue';

enableAutoUnmount(afterEach);

const { transport } = vi.hoisted(() => ({ transport: { paths: [] as string[] } }));

vi.mock('@/api', () => ({
	default: {
		get: (path: string) => {
			transport.paths.push(path);
			const id = path.split('/').pop();
			return Promise.resolve({ data: { data: { id, name: `Item ${id}` } } });
		},
	},
}));

vi.mock('@/composables/use-relation-m2o', () => ({
	useRelationM2O: () => ({
		relationInfo: ref<RelationM2O>({
			relation: {
				collection: 'articles',
				field: 'author',
				related_collection: 'authors_col',
				meta: null,
				schema: null,
			},
			relatedCollection: {
				name: 'Authors',
				collection: 'authors_col',
				icon: 'person',
				meta: null,
				schema: null,
				type: 'table',
			},
			relatedPrimaryKeyField: {
				name: 'ID',
				collection: 'authors_col',
				field: 'id',
				type: 'integer',
				meta: null,
				schema: null,
			},
			type: 'm2o',
		}),
	}),
}));

vi.mock('@/utils/adjust-fields-for-displays', () => ({
	adjustFieldsForDisplays: (fields: string[]) => fields,
}));

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

vi.mock('@/views/private/components/drawer-collection.vue', () => ({
	default: {
		name: 'DrawerCollectionStub',
		props: { active: { type: Boolean, default: false }, selection: { type: Array, default: () => [] } },
		emits: ['update:active', 'input'],
		template: '<div class="drawer-collection-stub" />',
	},
}));

const stubs = {
	'v-notice': { template: '<div><slot /></div>' },
	'v-input': { props: ['disabled'], template: '<div><slot name="input" /><slot name="append" /></div>' },
	'v-icon': { props: ['name'], emits: ['click'], template: '<i :data-name="name" @click="$emit(\'click\')" />' },
	'v-skeleton-loader': { template: '<div />' },
	'render-template': { template: '<div />' },
};

function drawer(wrapper: ReturnType<typeof mountDropdown>) {
	return wrapper.findComponent({ name: 'DrawerItemStub' });
}

function mountDropdown(props: Record<string, any>, permissions: Permission[] = []) {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: false } };
	(usePermissionsStore() as any).permissions = permissions;

	return mount(SelectDropdownM2O, {
		props: { collection: 'articles', field: 'author', template: '{{ id }}', ...props },
		global: { plugins: [i18n, pinia], stubs, directives: { tooltip: {} } },
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
	transport.paths = [];
});

describe('m2o dropdown drawer binding', () => {
	it('loads and targets a numeric key of 0', async () => {
		const wrapper = mountDropdown({ value: 0 });
		await flushPromises();

		expect(transport.paths).toContain('/items/authors_col/0');
		expect(drawer(wrapper).props('primaryKey')).toBe(0);
		expect(wrapper.findComponent({ name: 'DrawerCollectionStub' }).props('selection')).toEqual([0]);
	});

	it('loads an object relationship whose key is 0', async () => {
		const wrapper = mountDropdown({ value: { id: 0 } });
		await flushPromises();

		expect(transport.paths).toContain('/items/authors_col/0');
		expect(drawer(wrapper).props('primaryKey')).toBe(0);
	});

	it('targets a numeric key of 1 as a control', async () => {
		const wrapper = mountDropdown({ value: 1 });
		await flushPromises();

		expect(transport.paths).toContain('/items/authors_col/1');
		expect(drawer(wrapper).props('primaryKey')).toBe(1);
	});

	it('lets a create-only user open the create form', async () => {
		const wrapper = mountDropdown({ value: null }, [grant('authors_col', 'create')]);

		await flushPromises();
		await wrapper.find('[data-name="add"]').trigger('click');

		const item = drawer(wrapper);
		expect(item.props('active')).toBe(true);
		expect(item.props('primaryKey')).toBe('+');
		expect(item.props('disabled')).toBe(false);
	});

	it('still forwards an external read-only state to the drawer', async () => {
		const wrapper = mountDropdown({ value: null, disabled: true }, [grant('authors_col', 'create')]);

		await flushPromises();

		expect(drawer(wrapper).props('disabled')).toBe(true);
	});

	it('retains a key of 0 when applying keyless content edits', async () => {
		const wrapper = mountDropdown({ value: 0 });
		await flushPromises();

		drawer(wrapper).vm.$emit('input', { name: 'Renamed' });
		await flushPromises();

		expect(wrapper.emitted('input')?.[0]?.[0]).toEqual({ name: 'Renamed', id: 0 });
	});
});
