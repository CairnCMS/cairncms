import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import type { Field, Relation } from '@cairncms/types';
import { i18n } from '@/lang';
import { useFieldsStore } from '@/stores/fields';
import { useRelationsStore } from '@/stores/relations';
import DrawerBatch from './drawer-batch.vue';

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
const VDrawer = defineComponent({
	name: 'VDrawer',
	template: '<div><slot name="actions" /><slot /></div>',
});

// eslint-disable-next-line vue/one-component-per-file
const VForm = defineComponent({
	name: 'VForm',
	props: { modelValue: { type: Object, default: () => ({}) } },
	emits: ['update:modelValue'],
	template: '<div class="v-form-stub" />',
});

// eslint-disable-next-line vue/one-component-per-file
const VButton = defineComponent({
	name: 'VButton',
	emits: ['click'],
	template: '<button @click="$emit(\'click\')"><slot /></button>',
});

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

function mountDrawer() {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);
	seedSchema();

	return mount(DrawerBatch, {
		props: { collection: 'articles', primaryKeys: [1, 2, 3], active: true },
		global: {
			plugins: [pinia, i18n],
			stubs: { 'v-drawer': VDrawer, 'v-form': VForm, 'v-button': VButton, 'v-icon': true },
			directives: { tooltip: {} },
		},
	});
}

beforeEach(() => apiPatch.mockClear());

describe('drawer-batch strips unbound parent links', () => {
	it('removes a generated reverse marker under a new nested parent from the batch patch body', async () => {
		const wrapper = mountDrawer();
		await flushPromises();

		wrapper.findComponent({ name: 'VForm' }).vm.$emit('update:modelValue', {
			sections: { create: [{ article_id: '+', title: 'S', notes: { create: [{ section_id: '+', body: 'N' }] } }] },
		});

		await wrapper.find('button').trigger('click');
		await flushPromises();

		expect(apiPatch).toHaveBeenCalledTimes(1);
		const [path, body] = apiPatch.mock.calls.at(-1)!;
		expect(path).toBe('/items/articles');
		expect((body as any).keys).toEqual([1, 2, 3]);
		expect((body as any).data.sections.create[0]).toEqual({ title: 'S', notes: { create: [{ body: 'N' }] } });
	});
});
