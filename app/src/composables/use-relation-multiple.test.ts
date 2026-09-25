import { RelationQueryMultiple, useRelationMultiple } from '@/composables/use-relation-multiple';
import { fld, rel } from '@/__utils__/field-relation-fixtures';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { cloneDeep } from 'lodash';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { computed, defineComponent, h, ref, toRefs } from 'vue';
import { RelationM2A } from './use-relation-m2a';
import { RelationM2M } from './use-relation-m2m';
import { RelationO2M } from './use-relation-o2m';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { useFieldsStore } from '@/stores/fields';
import { useRelationsStore } from '@/stores/relations';
import { stripUnboundParentLinks } from '@/utils/strip-unbound-parent-links';

const { apiOverride } = vi.hoisted(() => ({
	apiOverride: { get: null as null | ((path: string, config: { params: Record<string, any> }) => any) },
}));

vi.mock('@/api', () => {
	return {
		default: {
			get: (path: string, config: { params: Record<string, any> }) => {
				if (apiOverride.get) return apiOverride.get(path, config);

				const { params } = config;

				if (path === '/items/worker' && params?.aggregate?.count === 'id') {
					return Promise.resolve({
						data: {
							data: [{ count: { id: workerData.length } }],
						},
					});
				} else if (path === '/items/worker') {
					return Promise.resolve({
						data: {
							data: workerData,
						},
					});
				} else if (path === '/items/article_m2a' && params?.aggregate?.count === 'id') {
					return Promise.resolve({
						data: {
							data: [{ count: { id: m2aData.length } }],
						},
					});
				} else if (path === '/items/facility_tag' && params?.aggregate?.count === 'id') {
					return Promise.resolve({ data: { data: [{ count: { id: 0 } }] } });
				} else if (path === '/items/facility_tag') {
					return Promise.resolve({ data: { data: [] } });
				} else {
					return Promise.resolve({
						data: {
							data: m2aData,
						},
					});
				}
			},
		},
	};
});

vi.mock('@/utils/unexpected-error', () => {
	return {
		unexpectedError: (error: any) => {
			throw error;
		},
	};
});

const relationO2M: RelationO2M = {
	relatedCollection: {
		name: 'Worker',
		collection: 'worker',
		icon: 'user',
		meta: null,
		schema: null,
		type: 'table',
	},
	relatedPrimaryKeyField: {
		name: 'ID',
		collection: 'worker',
		field: 'id',
		type: 'integer',
		meta: null,
		schema: null,
	},
	reverseJunctionField: {
		name: 'Facility',
		collection: 'facility',
		field: 'facility',
		type: 'integer',
		meta: null,
		schema: null,
	},
	relation: {
		collection: 'worker',
		field: 'facility',
		related_collection: 'facility',
		meta: null,
		schema: null,
	},
	type: 'o2m',
};

const workerData: Record<string, any>[] = [
	{ id: 1, name: 'test', facility: 1 },
	{ id: 2, name: 'test2', facility: 1 },
	{ id: 3, name: 'test3', facility: 1 },
	{ id: 4, name: 'test4', facility: 1 },
];

// eslint-disable-next-line vue/one-component-per-file
const TestComponent = defineComponent({
	props: ['value', 'relation', 'id'], // eslint-disable-line vue/require-prop-types
	emits: ['update:value'],
	setup(props) {
		const valueRef = ref(props.value);
		const { relation, id } = toRefs(props);

		const query = computed<RelationQueryMultiple>(() => {
			const q: RelationQueryMultiple = {
				limit: 15,
				page: 1,
				fields: ['id'],
			};

			return q;
		});

		// eslint-disable-next-line vue/no-dupe-keys
		return { value: valueRef, ...useRelationMultiple(valueRef, query, relation, id) };
	},
	render: () => h('div'),
});

/*
Facility                 Worker
┌─────────────┐          ┌─────────────────┐
│id: number   │◄────┐    │id: number       │
│name: string │     │    │name: string     │
│workers      │     └────┤facility: number │
│             │          │                 │
│             │          │                 │
└─────────────┘          └─────────────────┘
 */

describe('test o2m relation', () => {
	test('creating an item', async () => {
		const wrapper = mount(TestComponent, {
			props: { relation: relationO2M, value: [], id: 1 },
		});

		wrapper.vm.create({
			name: 'test5',
			facility: 1,
		});

		await flushPromises();

		expect(wrapper.vm.displayItems).toEqual([
			...workerData,
			{ name: 'test5', facility: 1, $type: 'created', $index: 0 },
		]);

		expect(wrapper.vm.value).toEqual({
			create: [
				{
					name: 'test5',
					facility: 1,
				},
			],
			update: [],
			delete: [],
		});
	});

	test('editing a created item', async () => {
		const wrapper = mount(TestComponent, {
			props: { relation: relationO2M, value: [], id: 1 },
		});

		wrapper.vm.create({
			name: 'test5',
			facility: 1,
		});

		wrapper.vm.update({
			name: 'test5 edited',
			facility: 2,
			$type: 'created',
			$index: 0,
		});

		await flushPromises();

		expect(wrapper.vm.displayItems).toEqual([
			...workerData,
			{ name: 'test5 edited', facility: 2, $type: 'created', $index: 0 },
		]);

		expect(wrapper.vm.value).toEqual({
			create: [
				{
					name: 'test5 edited',
					facility: 2,
				},
			],
			update: [],
			delete: [],
		});
	});

	test('removing a created item', async () => {
		const wrapper = mount(TestComponent, {
			props: { relation: relationO2M, value: [], id: 1 },
		});

		wrapper.vm.create({ name: 'test5', facility: 1 });

		wrapper.vm.remove({ name: 'test5', facility: 1, $type: 'created', $index: 0 });

		await flushPromises();

		expect(wrapper.vm.displayItems).toEqual(workerData);

		expect(wrapper.vm.value).toEqual(undefined);
	});

	test('updating an item', async () => {
		const wrapper = mount(TestComponent, {
			props: { relation: relationO2M, value: [], id: 1 },
		});

		wrapper.vm.update({ id: 2, name: 'test2-edited' });

		await flushPromises();

		const changes = cloneDeep(workerData);
		changes.splice(1, 1, { id: 2, name: 'test2-edited', facility: 1, $edits: 0, $type: 'updated', $index: 0 });

		expect(wrapper.vm.displayItems).toEqual(changes);

		expect(wrapper.vm.value).toEqual({
			create: [],
			update: [
				{
					id: 2,
					name: 'test2-edited',
				},
			],
			delete: [],
		});
	});

	test('removing an item', async () => {
		const wrapper = mount(TestComponent, {
			props: { relation: relationO2M, value: [], id: 1 },
		});

		wrapper.vm.remove({ id: 2 });

		await flushPromises();

		const changes = cloneDeep(workerData);
		changes.splice(1, 1, { id: 2, name: 'test2', facility: 1, $type: 'deleted', $index: 0 });

		expect(wrapper.vm.displayItems).toEqual(changes);
		expect(wrapper.vm.value).toEqual({ create: [], update: [], delete: [2] });
	});

	test('removing an edited item', async () => {
		const wrapper = mount(TestComponent, {
			props: { relation: relationO2M, value: [], id: 1 },
		});

		wrapper.vm.update({ id: 2, name: 'test2-edited' });
		wrapper.vm.remove({ id: 1 });
		wrapper.vm.remove({ id: 2 });

		await flushPromises();

		const changes = cloneDeep(workerData);
		changes.splice(1, 1, { id: 2, name: 'test2-edited', facility: 1, $type: 'deleted', $index: 1, $edits: 0 });
		changes.splice(0, 1, { id: 1, name: 'test', facility: 1, $type: 'deleted', $index: 0 });

		expect(wrapper.vm.displayItems).toEqual(changes);

		expect(wrapper.vm.value).toEqual({
			create: [],
			update: [
				{
					id: 2,
					name: 'test2-edited',
				},
			],
			delete: [1, 2],
		});
	});

	test('get item edits', async () => {
		const wrapper = mount(TestComponent, {
			props: { relation: relationO2M, value: [], id: 1 },
		});

		wrapper.vm.update({ id: 2, name: 'test2-edited' });

		await flushPromises();

		expect(wrapper.vm.getItemEdits(wrapper.vm.displayItems.find((item) => item.id === 2) as any)).toEqual({
			id: 2,
			name: 'test2-edited',
			$type: 'updated',
			$index: 0,
		});
	});
});

const relationM2A: RelationM2A = {
	allowedCollections: [
		{
			name: 'Text',
			collection: 'text',
			icon: 'user',
			meta: null,
			schema: null,
			type: 'table',
		},
		{
			name: 'Code',
			collection: 'code',
			icon: 'user',
			meta: null,
			schema: null,
			type: 'table',
		},
	],
	collectionField: {
		name: 'Collection',
		collection: 'article_m2a',
		field: 'collection',
		type: 'string',
		meta: null,
		schema: null,
	},
	junction: {
		collection: 'article_m2a',
		field: 'article_id',
		related_collection: 'article',
		meta: {
			id: 1,
			junction_field: 'item',
			many_collection: 'article_m2a',
			many_field: 'article_id',
			one_allowed_collections: null,
			one_collection: 'article',
			one_collection_field: null,
			one_deselect_action: 'nullify',
			one_field: 'content',
			sort_field: 'sort',
		},
		schema: null,
	},
	relation: {
		collection: 'article_m2a',
		field: 'item',
		related_collection: null,
		meta: {
			id: 2,
			junction_field: 'many_id',
			many_collection: 'article_m2a',
			many_field: 'item',
			one_allowed_collections: ['text', 'code'],
			one_collection: null,
			one_collection_field: 'collection',
			one_deselect_action: 'nullify',
			one_field: null,
			sort_field: null,
		},
		schema: null,
	},
	junctionCollection: {
		collection: 'article_m2a',
		name: 'Article M2A',
		icon: 'import_export',
		type: 'table',
		schema: null,
		meta: null,
	},
	junctionField: {
		collection: 'article_m2a',
		field: 'item',
		type: 'string',
		name: 'Item',
		meta: null,
		schema: null,
	},
	junctionPrimaryKeyField: {
		collection: 'article_m2a',
		field: 'id',
		type: 'integer',
		name: 'ID',
		meta: null,
		schema: null,
	},
	relationPrimaryKeyFields: {
		text: {
			collection: 'text',
			field: 'id',
			type: 'integer',
			name: 'ID',
			meta: null,
			schema: null,
		},
		code: {
			collection: 'code',
			field: 'id',
			type: 'integer',
			name: 'ID',
			meta: null,
			schema: null,
		},
	},
	reverseJunctionField: {
		collection: 'article_m2a',
		field: 'article_id',
		type: 'integer',
		name: 'Article ID',
		meta: null,
		schema: null,
	},
	sortField: 'sort',
	type: 'm2a',
};

const m2aData: Record<string, any>[] = [
	{ id: 1, article_id: 1, item: { id: 1 }, collection: 'text', sort: 1 },
	{ id: 2, article_id: 1, item: { id: 2 }, collection: 'text', sort: 2 },
	{ id: 3, article_id: 1, item: { id: 1 }, collection: 'code', sort: 3 },
];

// eslint-disable-next-line vue/one-component-per-file
const TestComponentM2A = defineComponent({
	props: ['value', 'relation', 'id'], // eslint-disable-line vue/require-prop-types
	emits: ['update:value'],
	setup(props) {
		const valueRef = ref(props.value);
		const { relation, id } = toRefs(props);

		const query = computed<RelationQueryMultiple>(() => {
			const q: RelationQueryMultiple = {
				limit: 15,
				page: 1,
				fields: ['id'],
			};

			return q;
		});

		// eslint-disable-next-line vue/no-dupe-keys
		return { value: valueRef, ...useRelationMultiple(valueRef, query, relation, id) };
	},
	render: () => h('div'),
});

/*
Article           Many|Any: article_m2a                    ┌─Text
┌─────────┐       ┌────────────────────────────────┐       │ ┌─────────┐
│id       ├───┐   │id: junctionPKField             │    ┌──┼─┤id       │
│content  │   └──►│article_id: reverseJunctionField│    │  │ │text     │
└─────────┘       │item: junctionField             │◄───┤  │ └─────────┘
				      │sort: sortField                 │    │  │
				      │collection: collectionField     │◄───┼──┤
				      └────────────────────────────────┘    │  │
														              │  └─Code
				AllowedCollection: [Text,Code]		        │    ┌─────────┐
				relatedPKFields: {Text: id,Code: id}        └────┤id       │
															                │code     │
															                └─────────┘
*/

describe('test m2a relation', () => {
	test('sorting an item', async () => {
		const wrapper = mount(TestComponentM2A, {
			props: {
				relation: relationM2A,
				value: [],
				id: 1,
			},
		});

		wrapper.vm.update(
			{ id: 1, item: { id: 1 }, collection: 'text', sort: 2 },
			{ id: 2, item: { id: 2 }, collection: 'text', sort: 3 },
			{ id: 3, item: { id: 1 }, collection: 'code', sort: 1 }
		);

		await flushPromises();

		expect(wrapper.vm.displayItems).toEqual([
			{
				id: 3,
				article_id: 1,
				item: { id: 1 },
				collection: 'code',
				sort: 1,
				$type: 'updated',
				$index: 2,
				$edits: 2,
			},
			{
				id: 1,
				article_id: 1,
				item: { id: 1 },
				collection: 'text',
				sort: 2,
				$type: 'updated',
				$index: 0,
				$edits: 0,
			},
			{
				id: 2,
				article_id: 1,
				item: { id: 2 },
				collection: 'text',
				sort: 3,
				$type: 'updated',
				$index: 1,
				$edits: 1,
			},
		]);
	});

	test('accepts a metadata-only update without a nested relationship', async () => {
		const wrapper = mount(TestComponentM2A, {
			props: {
				relation: relationM2A,
				value: [],
				id: 1,
			},
		});

		await flushPromises();

		wrapper.vm.update({ id: 2, item: { id: 2 }, collection: 'text', sort: 5 });

		await flushPromises();

		expect(() => wrapper.vm.update({ id: 2, sort: 9, $type: 'updated', $index: 0 })).not.toThrow();

		await flushPromises();

		expect(wrapper.vm.value).toEqual({ create: [], update: [{ id: 2, sort: 9 }], delete: [] });
	});
});

describe('staging identity from a reopened editor', () => {
	test('a preserved created marker replaces the pending create instead of appending', async () => {
		const wrapper = mount(TestComponent, {
			props: { relation: relationO2M, value: [], id: 1 },
		});

		wrapper.vm.create({ name: 'Original' });

		await flushPromises();

		wrapper.vm.update({ name: 'Revised', $type: 'created', $index: 0 });

		await flushPromises();

		expect(wrapper.vm.value).toEqual({ create: [{ name: 'Revised' }], update: [], delete: [] });
	});
});

const relationM2M: RelationM2M = {
	relatedCollection: { name: 'Tag', collection: 'tag', icon: 'sell', meta: null, schema: null, type: 'table' },
	relatedPrimaryKeyField: { name: 'ID', collection: 'tag', field: 'id', type: 'integer', meta: null, schema: null },
	junctionCollection: {
		name: 'Facility Tag',
		collection: 'facility_tag',
		icon: 'import_export',
		meta: null,
		schema: null,
		type: 'table',
	},
	junctionPrimaryKeyField: {
		name: 'ID',
		collection: 'facility_tag',
		field: 'id',
		type: 'integer',
		meta: null,
		schema: null,
	},
	junctionField: {
		name: 'Tag',
		collection: 'facility_tag',
		field: 'tag_id',
		type: 'integer',
		meta: null,
		schema: null,
	},
	reverseJunctionField: {
		name: 'Facility',
		collection: 'facility_tag',
		field: 'facility_id',
		type: 'integer',
		meta: null,
		schema: null,
	},
	relation: {
		collection: 'facility_tag',
		field: 'tag_id',
		related_collection: 'tag',
		meta: {
			id: 1,
			junction_field: 'facility_id',
			many_collection: 'facility_tag',
			many_field: 'tag_id',
			one_allowed_collections: null,
			one_collection: 'tag',
			one_collection_field: null,
			one_deselect_action: 'nullify',
			one_field: null,
			sort_field: 'sort',
		},
		schema: null,
	},
	junction: {
		collection: 'facility_tag',
		field: 'facility_id',
		related_collection: 'facility',
		meta: {
			id: 2,
			junction_field: 'tag_id',
			many_collection: 'facility_tag',
			many_field: 'facility_id',
			one_allowed_collections: null,
			one_collection: 'facility',
			one_collection_field: null,
			one_deselect_action: 'nullify',
			one_field: 'tags',
			sort_field: 'sort',
		},
		schema: null,
	},
	sortField: 'sort',
	type: 'm2m',
};

describe('test m2m relation', () => {
	test('accepts a metadata-only update without a nested relationship', async () => {
		const wrapper = mount(TestComponent, {
			props: { relation: relationM2M, value: [], id: 1 },
		});

		await flushPromises();

		wrapper.vm.update({ id: 2, tag_id: { id: 7 }, sort: 5 });

		await flushPromises();

		expect(() => wrapper.vm.update({ id: 2, sort: 9, $type: 'updated', $index: 0 })).not.toThrow();

		await flushPromises();

		expect(wrapper.vm.value).toEqual({ create: [], update: [{ id: 2, sort: 9 }], delete: [] });
	});
});

function apiGetForRecords(records: Record<string, Record<string, any>[]>) {
	return (path: string, config: { params: Record<string, any> }) => {
		const collection = path.replace('/items/', '');
		const data = records[collection] ?? [];

		if (config?.params?.aggregate?.count) {
			return Promise.resolve({ data: { data: [{ count: { id: data.length } }] } });
		}

		return Promise.resolve({ data: { data } });
	};
}

type ApproachACase = {
	name: string;
	relation: RelationO2M | RelationM2M | RelationM2A;
	doSelect: (vm: any) => void;
	records: Record<string, Record<string, any>[]>;
	parentCollection: string;
	oneField: string;
	reverseField: string;
	branch: 'create' | 'update';
	findSelected: (items: any[]) => any;
	assertContent: (item: any) => void;
	seed: () => void;
};

const approachACases: ApproachACase[] = [
	{
		name: 'o2m',
		relation: relationO2M,
		doSelect: (vm: any) => vm.select([100]),
		records: { worker: [{ id: 100, name: 'Selected Worker' }] },
		parentCollection: 'facility',
		oneField: 'workers',
		reverseField: 'facility',
		branch: 'update' as const,
		findSelected: (items: any[]) => items.find((item) => item.id === 100),
		assertContent: (item: any) => expect(item.name).toBe('Selected Worker'),
		seed: () => {
			useFieldsStore().fields = [fld('facility', 'workers'), fld('worker', 'id', true)];

			useRelationsStore().relations = [
				rel('worker', 'facility', 'facility', { one_field: 'workers', many_field: 'facility' }),
			];
		},
	},
	{
		name: 'm2m',
		relation: relationM2M,
		doSelect: (vm: any) => vm.select([200]),
		records: { tag: [{ id: 200, name: 'Selected Tag' }] },
		parentCollection: 'facility',
		oneField: 'tags',
		reverseField: 'facility_id',
		branch: 'create' as const,
		findSelected: (items: any[]) => items.find((item) => item.tag_id?.id === 200),
		assertContent: (item: any) => expect(item.tag_id.name).toBe('Selected Tag'),
		seed: () => {
			useFieldsStore().fields = [
				fld('facility', 'tags'),
				fld('facility_tag', 'id', true),
				fld('facility_tag', 'facility_id'),
				fld('facility_tag', 'tag_id'),
				fld('tag', 'id', true),
			];

			useRelationsStore().relations = [
				rel('facility_tag', 'facility_id', 'facility', { one_field: 'tags', junction_field: 'tag_id' }),
				rel('facility_tag', 'tag_id', 'tag', { junction_field: 'facility_id' }),
			];
		},
	},
	{
		name: 'm2a',
		relation: relationM2A,
		doSelect: (vm: any) => vm.select([300], 'text'),
		records: { text: [{ id: 300, name: 'Selected Text' }] },
		parentCollection: 'article',
		oneField: 'content',
		reverseField: 'article_id',
		branch: 'create' as const,
		findSelected: (items: any[]) => items.find((item) => item.item?.id === 300),
		assertContent: (item: any) => expect(item.item.name).toBe('Selected Text'),
		seed: () => {
			useFieldsStore().fields = [
				fld('article', 'content'),
				fld('article_m2a', 'id', true),
				fld('article_m2a', 'article_id'),
				fld('article_m2a', 'item'),
				fld('article_m2a', 'collection'),
				fld('text', 'id', true),
				fld('code', 'id', true),
			];

			useRelationsStore().relations = [
				rel('article_m2a', 'article_id', 'article', { one_field: 'content', junction_field: 'item' }),
				rel('article_m2a', 'item', null, {
					junction_field: 'article_id',
					one_collection_field: 'collection',
					one_allowed_collections: ['text', 'code'],
				}),
			];
		},
	},
];

enableAutoUnmount(afterEach);

afterEach(() => {
	apiOverride.get = null;
});

describe.each(approachACases)('approach A client end to end ($name)', (config) => {
	function strip(value: any) {
		return stripUnboundParentLinks(config.parentCollection, { [config.oneField]: value }, false);
	}

	function emptyChanges() {
		return { create: [], update: [], delete: [] };
	}

	function expectNoOperations(value: any) {
		const changes = value ?? emptyChanges();
		expect(changes.create ?? []).toEqual([]);
		expect(changes.update ?? []).toEqual([]);
		expect(changes.delete ?? []).toEqual([]);
	}

	test('previews fetched content while keeping the marker, and the outgoing copy is stripped through reopen and removal', async () => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
		config.seed();
		apiOverride.get = apiGetForRecords(config.records);

		const wrapper = mount(TestComponent, { props: { relation: config.relation, value: [], id: '+' } });
		await flushPromises();

		config.doSelect(wrapper.vm);
		await flushPromises();

		const staged = wrapper.vm.value;
		expect(staged[config.branch][0][config.reverseField]).toBe('+');

		const preview = config.findSelected(wrapper.vm.displayItems);
		expect(preview).toBeDefined();
		expect(preview[config.reverseField]).toBe('+');
		config.assertContent(preview);

		const snapshot = cloneDeep(staged);
		const outgoing = strip(staged);
		expect(outgoing[config.oneField][config.branch][0][config.reverseField]).toBeUndefined();
		expect(staged).toEqual(snapshot);

		const reopened = mount(TestComponent, { props: { relation: config.relation, value: cloneDeep(staged), id: '+' } });
		await flushPromises();

		const reopenedStaged = reopened.vm.value;
		expect(reopenedStaged[config.branch][0][config.reverseField]).toBe('+');

		const reopenedPreview = config.findSelected(reopened.vm.displayItems);
		expect(reopenedPreview).toBeDefined();
		expect(reopenedPreview[config.reverseField]).toBe('+');
		config.assertContent(reopenedPreview);

		expect(strip(reopenedStaged)[config.oneField][config.branch][0][config.reverseField]).toBeUndefined();

		reopened.vm.remove(config.findSelected(reopened.vm.displayItems));
		await flushPromises();

		expectNoOperations(reopened.vm.value);
		expectNoOperations(strip(reopened.vm.value ?? emptyChanges())[config.oneField]);
	});
});
