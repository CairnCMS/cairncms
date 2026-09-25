import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import type { Field, Relation } from '@cairncms/types';
import { useFieldsStore } from '@/stores/fields';
import { useRelationsStore } from '@/stores/relations';
import PanelList from './panel-list.vue';

function fld(collection: string, name: string, primary = false): Field {
	return {
		collection,
		field: name,
		name,
		type: primary ? 'integer' : 'string',
		schema: primary
			? {
					name,
					table: collection,
					data_type: 'integer',
					default_value: null,
					max_length: null,
					numeric_precision: null,
					numeric_scale: null,
					is_nullable: false,
					is_unique: true,
					is_primary_key: true,
					is_generated: false,
					has_auto_increment: true,
					foreign_key_table: null,
					foreign_key_column: null,
			  }
			: null,
		meta: null,
		children: null,
	};
}

function rel(
	collection: string,
	field: string,
	related: string,
	meta: Partial<NonNullable<Relation['meta']>>
): Relation {
	return {
		collection,
		field,
		related_collection: related,
		schema: null,
		meta: {
			id: 0,
			many_collection: collection,
			many_field: field,
			one_collection: related,
			one_field: null,
			one_collection_field: null,
			one_allowed_collections: null,
			one_deselect_action: 'nullify',
			junction_field: null,
			sort_field: null,
			...meta,
		},
	};
}

const apiPatch = vi.fn((_path: string, _body?: unknown) => Promise.resolve({}));

vi.mock('@/api', () => ({
	default: {
		patch: (path: string, body?: unknown) => apiPatch(path, body),
	},
}));

enableAutoUnmount(afterEach);

// eslint-disable-next-line vue/one-component-per-file
const DrawerItemStub = defineComponent({
	name: 'DrawerItemStub',
	props: {
		active: { type: Boolean, default: false },
		collection: { type: String, default: '' },
		primaryKey: { type: [String, Number], default: undefined },
		edits: { type: Object, default: undefined },
	},
	emits: ['update:active', 'input'],
	template: '<div class="drawer-item-stub" />',
});

// eslint-disable-next-line vue/one-component-per-file
const VListItem = defineComponent({
	name: 'VListItem',
	props: { clickable: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<div class="v-list-item-stub" @click="$emit(\'click\')"><slot /></div>',
});

const passthrough = { template: '<div><slot /></div>' };

function mountPanel(data: Record<string, any>[]) {
	const pinia = createTestingPinia({ createSpy: vi.fn });
	setActivePinia(pinia);

	(useFieldsStore() as any).getPrimaryKeyFieldForCollection = () => ({ field: 'id' });

	return mount(PanelList, {
		props: { collection: 'articles', dashboard: 'dash-1', linkToItem: true, data },
		global: {
			plugins: [pinia],
			stubs: {
				'v-list': passthrough,
				'v-list-item': VListItem,
				'render-template': { template: '<div />' },
				'drawer-item': DrawerItemStub,
			},
		},
	});
}

function drawer(wrapper: ReturnType<typeof mountPanel>) {
	return wrapper.findComponent({ name: 'DrawerItemStub' });
}

beforeEach(() => {
	apiPatch.mockClear();
});

describe('list panel row editing', () => {
	it('opens the drawer for a row whose primary key is numeric zero', async () => {
		const wrapper = mountPanel([{ id: 0, title: 'Zero' }]);
		await flushPromises();

		await wrapper.find('.v-list-item-stub').trigger('click');

		expect(drawer(wrapper).props('active')).toBe(true);
		expect(drawer(wrapper).props('primaryKey')).toBe(0);
	});

	it('patches only the authorized content, using the key as the selector, for a zero key', async () => {
		const wrapper = mountPanel([{ id: 0, title: 'Zero' }]);
		await flushPromises();

		await wrapper.find('.v-list-item-stub').trigger('click');

		drawer(wrapper).vm.$emit('input', { title: 'Updated', id: 0 });
		await flushPromises();

		expect(apiPatch).toHaveBeenCalledTimes(1);
		expect(apiPatch).toHaveBeenCalledWith('/items/articles/0', { title: 'Updated' });
	});

	it('strips the injected primary key from the body for a non-zero key', async () => {
		const wrapper = mountPanel([{ id: 5, title: 'Five' }]);
		await flushPromises();

		await wrapper.find('.v-list-item-stub').trigger('click');

		expect(drawer(wrapper).props('primaryKey')).toBe(5);

		drawer(wrapper).vm.$emit('input', { title: 'Renamed', id: 5 });
		await flushPromises();

		expect(apiPatch).toHaveBeenCalledWith('/items/articles/5', { title: 'Renamed' });
	});
});

describe('list panel strips unbound parent links', () => {
	function seedSchema() {
		const fieldsStore = useFieldsStore();
		const relationsStore = useRelationsStore();

		fieldsStore.fields = [
			fld('articles', 'id', true),
			fld('articles', 'sections'),
			fld('sections', 'id', true),
			fld('sections', 'article_id'),
			fld('sections', 'notes'),
			fld('notes', 'id', true),
			fld('notes', 'section_id'),
		];

		relationsStore.relations = [
			rel('sections', 'article_id', 'articles', { one_field: 'sections', many_field: 'article_id' }),
			rel('notes', 'section_id', 'sections', { one_field: 'notes', many_field: 'section_id' }),
		];
	}

	function mountPanel(data: Record<string, any>[]) {
		const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
		setActivePinia(pinia);
		seedSchema();

		return mount(PanelList, {
			props: { collection: 'articles', dashboard: 'dash-1', linkToItem: true, data },
			global: {
				plugins: [pinia],
				stubs: {
					'v-list': passthrough,
					'v-list-item': VListItem,
					'render-template': { template: '<div />' },
					'drawer-item': DrawerItemStub,
				},
			},
		});
	}

	it('removes a generated reverse marker under a new nested parent from the patch body', async () => {
		const wrapper = mountPanel([{ id: 5, title: 'Five' }]);
		await flushPromises();

		await wrapper.find('.v-list-item-stub').trigger('click');

		wrapper.findComponent({ name: 'DrawerItemStub' }).vm.$emit('input', {
			id: 5,
			sections: { create: [{ title: 'S', notes: { create: [{ section_id: '+', body: 'N' }] } }] },
		});

		await flushPromises();

		const body = apiPatch.mock.calls.at(-1)![1] as any;
		expect(body.sections.create[0].notes.create[0]).toEqual({ body: 'N' });
	});
});
