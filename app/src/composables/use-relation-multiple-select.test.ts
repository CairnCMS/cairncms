import { RelationQueryMultiple, useRelationMultiple } from '@/composables/use-relation-multiple';
import { useServerStore } from '@/stores/server';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { describe, expect, test, vi } from 'vitest';
import { computed, defineComponent, h, ref, toRefs } from 'vue';
import { RelationO2M } from './use-relation-o2m';

type Worker = { id: number; name: string; facility: number };

type MockParams = {
	aggregate?: { count?: string };
	filter?: { id?: { _in?: number[] } };
	page?: number;
	limit?: number;
};

const workers: Worker[] = [
	{ id: 1, name: 'worker-1', facility: 1 },
	{ id: 2, name: 'worker-2', facility: 1 },
	{ id: 3, name: 'worker-3', facility: 1 },
];

const apiGet = vi.fn((path: string, config: { params?: MockParams } = {}) => {
	const params = config.params ?? {};

	if (params.aggregate?.count === 'id') {
		return Promise.resolve({ data: { data: [{ count: { id: 0 } }] } });
	}

	if (params.filter?.id?._in && params.page && params.limit) {
		const ids = params.filter.id._in;
		const matching = workers.filter((worker) => ids.includes(worker.id));
		const slice = matching.slice((params.page - 1) * params.limit, params.page * params.limit);
		return Promise.resolve({ data: { data: slice } });
	}

	return Promise.resolve({ data: { data: [] } });
});

vi.mock('@/api', () => ({
	default: { get: (path: string, config?: { params?: MockParams }) => apiGet(path, config) },
}));

vi.mock('@/utils/unexpected-error', () => ({
	unexpectedError: (error: unknown) => {
		throw error;
	},
}));

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

// eslint-disable-next-line vue/one-component-per-file
const TestComponent = defineComponent({
	props: ['value', 'relation', 'id'], // eslint-disable-line vue/require-prop-types
	setup(props) {
		const valueRef = ref(props.value);
		const { relation, id } = toRefs(props);

		const query = computed<RelationQueryMultiple>(() => ({ limit: 15, page: 1, fields: ['id', 'name'] }));

		// eslint-disable-next-line vue/no-dupe-keys
		return { value: valueRef, ...useRelationMultiple(valueRef, query, relation, id) };
	},
	render: () => h('div'),
});

describe('selected display under a query limit maximum', () => {
	test('pages through the selected-item display fetch and reaches every selected item', async () => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
		useServerStore().info.queryLimit = { default: 100, max: 2 };

		const wrapper = mount(TestComponent, {
			props: {
				relation: relationO2M,
				value: {
					create: [],
					update: [
						{ id: 1, facility: 1 },
						{ id: 2, facility: 1 },
						{ id: 3, facility: 1 },
					],
					delete: [],
				},
				id: 1,
			},
		});

		await flushPromises();

		const displayed = wrapper.vm.displayItems as { id: number; name?: string }[];

		expect(displayed.map((item) => item.id).sort()).toEqual([1, 2, 3]);
		expect(displayed.find((item) => item.id === 3)?.name).toBe('worker-3');
	});
});
