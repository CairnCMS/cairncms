import api from '@/api';
import { useFlowsStore } from '@/stores/flows';
import { Vector2 } from '@/utils/vector2';
import type { FlowRaw, OperationRaw } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import Operation from './components/operation.vue';
import FlowDrawer from './flow-drawer.vue';
import FlowItem from './flow.vue';

const shortcuts = new Map<string, () => void>();

vi.mock('@/composables/use-shortcut', () => ({
	useShortcut: (keys: string, handler: () => void) => {
		shortcuts.set(keys, handler);
	},
}));

vi.mock('@/composables/use-edits-guard', () => ({
	useEditsGuard: () => ({ confirmLeave: ref(false), leaveTo: ref(null) }),
}));

vi.mock('@/extensions', () => ({
	useExtensions: () => ({ operations: ref([]) }),
}));

vi.mock('@/router', () => ({
	router: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock('@/api', () => ({
	default: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

enableAutoUnmount(afterEach);

const i18n = createI18n({ legacy: false, missingWarn: false, fallbackWarn: false });

const PrivateView = defineComponent({
	name: 'PrivateView',
	props: { title: { type: String, default: '' } },
	template: '<div><h1 class="title">{{ title }}</h1><slot name="actions" /><slot /></div>',
});

const VWorkspace = defineComponent({
	name: 'VWorkspace',
	props: { tiles: { type: Array, default: () => [] } },
	template: '<div><template v-for="tile in tiles" :key="tile.id"><slot name="tile" :tile="tile" /></template></div>',
});

const RouterViewStub = defineComponent({
	name: 'RouterViewStub',
	emits: ['save', 'cancel'],
	template: '<div />',
});

function operation(id: string, overrides: Partial<OperationRaw> = {}): OperationRaw {
	return {
		id,
		name: id,
		key: id.replace('-', '_'),
		type: 'log',
		position_x: 19,
		position_y: 1,
		options: {},
		resolve: null,
		reject: null,
		flow: 'flow-1',
		date_created: '2026-11-20T00:00:00.000Z',
		user_created: 'admin',
		...overrides,
	};
}

function storedFlow(overrides: Partial<FlowRaw> = {}): FlowRaw {
	return {
		id: 'flow-1',
		name: 'Nightly sync',
		icon: 'bolt',
		color: null,
		description: null,
		status: 'active',
		trigger: 'webhook',
		options: { method: 'GET' },
		operation: 'op-1',
		operations: [operation('op-1', { resolve: 'op-2' }), operation('op-2', { position_x: 37 })],
		date_created: '2026-11-20T00:00:00.000Z',
		user_created: 'admin',
		accountability: 'all',
		...overrides,
	};
}

function mountFlow(flow: FlowRaw = storedFlow()) {
	const pinia = createTestingPinia({ createSpy: vi.fn });
	const flowsStore = useFlowsStore(pinia);
	flowsStore.flows = [flow];

	vi.mocked(api.get).mockResolvedValue({ data: { data: structuredClone(flow) } });
	vi.mocked(api.patch).mockResolvedValue({ data: { data: null } });

	const wrapper = shallowMount(FlowItem, {
		props: { primaryKey: flow.id },
		global: {
			plugins: [i18n, pinia],
			stubs: { 'private-view': PrivateView, 'v-workspace': VWorkspace, 'router-view': RouterViewStub },
			directives: { tooltip: {}, md: {} },
		},
	});

	return { wrapper, flowsStore };
}

type FlowWrapper = ReturnType<typeof mountFlow>['wrapper'];

function triggerPanel(wrapper: FlowWrapper) {
	return wrapper.findAllComponents(Operation).find((panel) => panel.props('panel').id === '$trigger')!;
}

function patchBody(): Record<string, any> {
	return vi.mocked(api.patch).mock.lastCall![1] as Record<string, any>;
}

beforeEach(() => {
	shortcuts.clear();
	vi.clearAllMocks();
});

describe('Flow editor settings', () => {
	test('shows settings saved through the settings drawer', async () => {
		const { wrapper, flowsStore } = mountFlow();
		await flushPromises();

		flowsStore.flows = [storedFlow({ name: 'Nightly import', options: { method: 'POST' } })];
		await flushPromises();

		expect(wrapper.find('.title').text()).toBe('Nightly import');
		expect(triggerPanel(wrapper).props('panel').options).toEqual({ method: 'POST' });
		expect(vi.mocked(api.get)).not.toHaveBeenCalled();
	});

	test('keeps a staged status across a store refresh', async () => {
		const { wrapper, flowsStore } = mountFlow();
		await flushPromises();

		triggerPanel(wrapper).vm.$emit('flow-status', 'inactive');
		flowsStore.flows = [storedFlow({ name: 'Nightly import' })];
		await flushPromises();

		expect(triggerPanel(wrapper).props('flow').status).toBe('inactive');
		expect(wrapper.find('.title').text()).toBe('Nightly import');

		shortcuts.get('meta+s')!();
		await flushPromises();

		expect(patchBody().status).toBe('inactive');
	});

	test('keeps a staged new first operation across a store refresh', async () => {
		const { wrapper, flowsStore } = mountFlow(storedFlow({ operation: null, operations: [] }));
		await flushPromises();

		triggerPanel(wrapper).vm.$emit('create', '$trigger', 'resolve');
		await wrapper.setProps({ operationId: '+' });
		wrapper.findComponent(RouterViewStub).vm.$emit('save', { name: 'Notify', key: 'notify', type: 'log' });
		await wrapper.setProps({ operationId: undefined });
		flowsStore.flows = [storedFlow({ name: 'Nightly import', operation: null, operations: [] })];
		await flushPromises();

		const staged = wrapper.findAllComponents(Operation).find((panel) => panel.props('panel').key === 'notify');

		expect(staged).toBeDefined();
		expect(triggerPanel(wrapper).props('panel').resolve).toBe(staged!.props('panel').id);
	});

	test('keeps a staged trigger disconnect across a store refresh', async () => {
		const { wrapper, flowsStore } = mountFlow();
		await flushPromises();

		triggerPanel(wrapper).vm.$emit('arrow-move', { id: '$trigger', type: 'resolve', pos: new Vector2(10000, 10000) });
		triggerPanel(wrapper).vm.$emit('arrow-stop');
		flowsStore.flows = [storedFlow({ name: 'Nightly import' })];
		await flushPromises();

		expect(triggerPanel(wrapper).props('panel').resolve).toBeUndefined();

		shortcuts.get('meta+s')!();
		await flushPromises();

		expect(patchBody().operation).toBeNull();
	});
});

describe('Flow editor save payload', () => {
	test('saves only editor changes after settings are saved in the drawer', async () => {
		const { wrapper, flowsStore } = mountFlow();
		await flushPromises();

		triggerPanel(wrapper).vm.$emit('arrow-move', { id: '$trigger', type: 'resolve', pos: new Vector2(10000, 10000) });
		triggerPanel(wrapper).vm.$emit('arrow-stop');

		flowsStore.flows = [
			storedFlow({ name: 'Nightly import', options: { method: 'POST' }, accountability: 'activity' }),
		];

		await flushPromises();

		shortcuts.get('meta+s')!();
		await flushPromises();

		const body = patchBody();

		expect(body.operation).toBeNull();
		expect(body.operations).toBeDefined();
		expect(body).not.toHaveProperty('name');
		expect(body).not.toHaveProperty('options');
		expect(body).not.toHaveProperty('accountability');
	});

	test('keeps a staged status when the first operation is deleted', async () => {
		const { wrapper } = mountFlow();
		await flushPromises();

		triggerPanel(wrapper).vm.$emit('flow-status', 'inactive');

		wrapper
			.findAllComponents(Operation)
			.find((panel) => panel.props('panel').id === 'op-1')!
			.vm.$emit('delete', 'op-1');

		await flushPromises();

		shortcuts.get('meta+s')!();
		await flushPromises();

		const body = patchBody();

		expect(body.status).toBe('inactive');
		expect(body.operation).toBeNull();
		expect(body.operations.delete).toEqual(['op-1']);
	});
});

describe('Flow editor save shortcut', () => {
	async function mountWithStagedChange() {
		const mounted = mountFlow();
		await flushPromises();

		triggerPanel(mounted.wrapper).vm.$emit('flow-status', 'inactive');
		await flushPromises();

		return mounted;
	}

	async function pressSave() {
		shortcuts.get('meta+s')!();
		await flushPromises();
	}

	test('saves when no drawer is open', async () => {
		await mountWithStagedChange();

		await pressSave();

		expect(vi.mocked(api.patch)).toHaveBeenCalledTimes(1);
		expect(patchBody().status).toBe('inactive');
	});

	test.each([
		['an existing operation', 'op-1'],
		['a new operation', '+'],
	])('does not save while the drawer for %s is open', async (_label, operationId) => {
		const { wrapper } = await mountWithStagedChange();

		await wrapper.setProps({ operationId });
		await pressSave();

		expect(vi.mocked(api.patch)).not.toHaveBeenCalled();
	});

	test('does not save while the trigger drawer is open, and saves after it closes', async () => {
		const { wrapper } = await mountWithStagedChange();

		triggerPanel(wrapper).vm.$emit('edit', triggerPanel(wrapper).props('panel'));
		await flushPromises();
		await pressSave();

		expect(vi.mocked(api.patch)).not.toHaveBeenCalled();

		wrapper.findComponent(FlowDrawer).vm.$emit('cancel');
		await flushPromises();
		await pressSave();

		expect(vi.mocked(api.patch)).toHaveBeenCalledTimes(1);
		expect(patchBody().status).toBe('inactive');
	});
});
