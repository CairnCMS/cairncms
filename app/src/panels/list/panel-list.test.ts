import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { useFieldsStore } from '@/stores/fields';
import PanelList from './panel-list.vue';

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
