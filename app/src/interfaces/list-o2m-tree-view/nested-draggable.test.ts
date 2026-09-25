import { RelationO2M } from '@/composables/use-relation-o2m';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NestedDraggable from './nested-draggable.vue';

enableAutoUnmount(afterEach);

const createSpy = vi.fn();

vi.mock('@/composables/use-relation-multiple', () => ({
	useRelationMultiple: () => ({
		displayItems: { value: [] },
		create: createSpy,
		update: vi.fn(),
		remove: vi.fn(),
		select: vi.fn(),
		isLocalItem: vi.fn(() => false),
		getItemEdits: vi.fn(() => ({})),
		cleanItem: (item: Record<string, any>) =>
			Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith('$'))),
	}),
}));

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock('@/views/private/components/drawer-item.vue', () => ({
	default: { name: 'DrawerItemStub', template: '<div />' },
}));

vi.mock('@/views/private/components/drawer-collection.vue', () => ({
	default: { name: 'DrawerCollectionStub', template: '<div />' },
}));

vi.mock('vuedraggable', () => ({
	default: { name: 'Draggable', emits: ['change', 'start', 'end'], template: '<div><slot /></div>' },
}));

const relationInfo: RelationO2M = {
	type: 'o2m',
	relation: { collection: 'sections', field: 'article_id', related_collection: 'articles', schema: null, meta: null },
	relatedCollection: { name: 'Sections', collection: 'sections', icon: 'box', meta: null, schema: null, type: 'table' },
	relatedPrimaryKeyField: {
		name: 'ID',
		collection: 'sections',
		field: 'id',
		type: 'integer',
		schema: null,
		meta: null,
	},
	reverseJunctionField: {
		name: 'Article',
		collection: 'sections',
		field: 'article_id',
		type: 'integer',
		schema: null,
		meta: null,
	},
};

function mountTree(primaryKey: string | number) {
	return mount(NestedDraggable, {
		props: {
			modelValue: { create: [], update: [], delete: [] },
			template: '{{ id }}',
			collection: 'sections',
			field: 'children',
			primaryKey,
			fields: ['id'],
			relationInfo,
			enableCreate: true,
			enableSelect: true,
			customFilter: {},
			itemsMoved: [],
		},
		global: {
			stubs: { ItemPreview: true, 'item-preview': true, 'v-button': true, 'v-icon': true },
		},
	});
}

afterEach(() => createSpy.mockClear());

describe('nested-draggable created drag', () => {
	it('links a moved staged child to the destination parent, not the source', async () => {
		const wrapper = mountTree(11);

		wrapper.findComponent({ name: 'Draggable' }).vm.$emit('change', {
			added: { newIndex: 0, element: { $type: 'created', $index: 0, id: '+', article_id: 10, title: 'Child' } },
		});

		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(createSpy.mock.calls[0][0]).toEqual({ id: '+', article_id: 11, title: 'Child' });
	});

	it('keeps the new-parent marker for a moved child under a new destination', async () => {
		const wrapper = mountTree('+');

		wrapper.findComponent({ name: 'Draggable' }).vm.$emit('change', {
			added: { newIndex: 0, element: { $type: 'created', $index: 0, id: '+', article_id: 10, title: 'Child' } },
		});

		expect(createSpy.mock.calls[0][0].article_id).toBe('+');
	});
});
