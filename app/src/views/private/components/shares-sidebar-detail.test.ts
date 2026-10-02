import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { createI18n } from 'vue-i18n';
import { Share } from '@cairncms/types';
import { useFieldsStore } from '@/stores/fields';
import SharesSidebarDetail from './shares-sidebar-detail.vue';

const apiGet = vi.fn((_path: string, _config?: unknown) => Promise.resolve({ data: { data: [] as Share[] } }));
const apiPost = vi.fn((_path: string, _body?: unknown) => Promise.resolve({}));
const apiPatch = vi.fn((_path: string, _body?: unknown) => Promise.resolve({}));

const shareId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const existingShare = {
	id: shareId,
	name: 'Old',
	collection: 'articles',
	item: '1',
	role: 'role-1',
	password: '',
	user_created: 'user-1',
	date_created: '2026-01-01T00:00:00Z',
	date_start: null,
	date_end: null,
	times_used: 0,
	max_uses: null,
} satisfies Share;

vi.mock('@/api', () => ({
	default: {
		get: (path: string, config?: unknown) => apiGet(path, config),
		post: (path: string, body?: unknown) => apiPost(path, body),
		patch: (path: string, body?: unknown) => apiPatch(path, body),
	},
}));

vi.mock('@/composables/use-clipboard', () => ({ useClipboard: () => ({ copyToClipboard: vi.fn() }) }));
vi.mock('@/utils/get-root-path', () => ({ getRootPath: () => '/' }));

vi.mock('@/views/private/components/drawer-item.vue', () => ({
	default: {
		name: 'DrawerItemStub',
		props: {
			active: { type: Boolean, default: false },
			collection: { type: String, default: '' },
			primaryKey: { type: [String, Number], default: undefined },
		},
		emits: ['update:active', 'input'],
		template: '<div class="drawer-item-stub" />',
	},
}));

enableAutoUnmount(afterEach);

const i18n = createI18n({ legacy: false });

// eslint-disable-next-line vue/one-component-per-file
const ShareItem = defineComponent({
	name: 'ShareItem',
	props: { share: { type: Object, default: () => ({}) } },
	emits: ['copy', 'edit', 'delete', 'invite'],
	template: '<div class="share-item-stub" />',
});

// eslint-disable-next-line vue/one-component-per-file
const VButton = defineComponent({
	name: 'VButton',
	emits: ['click'],
	template: '<button @click="$emit(\'click\')"><slot /></button>',
});

function mountShares() {
	const pinia = createTestingPinia({ createSpy: vi.fn });
	setActivePinia(pinia);

	(useFieldsStore() as any).getPrimaryKeyFieldForCollection = () => ({ field: 'id' });

	return mount(SharesSidebarDetail, {
		props: { collection: 'articles', primaryKey: 1, allowed: true },
		global: {
			plugins: [i18n, pinia],
			stubs: {
				'sidebar-detail': { template: '<div><slot /></div>' },
				'share-item': ShareItem,
				'v-button': VButton,
				'v-dialog': { template: '<div />' },
				'v-notice': { template: '<div><slot /></div>' },
				'v-progress-linear': { template: '<div />' },
				'v-icon': { template: '<i />' },
				'v-input': { template: '<input />' },
				'v-textarea': { template: '<textarea />' },
				'v-card': { template: '<div><slot /></div>' },
				'v-card-title': { template: '<div><slot /></div>' },
				'v-card-text': { template: '<div><slot /></div>' },
				'v-card-actions': { template: '<div><slot /></div>' },
			},
			directives: { tooltip: {} },
		},
	});
}

function drawer(wrapper: ReturnType<typeof mountShares>) {
	return wrapper.findComponent({ name: 'DrawerItemStub' });
}

beforeEach(() => {
	apiGet.mockClear();
	apiGet.mockResolvedValue({ data: { data: [] } });
	apiPost.mockClear();
	apiPatch.mockClear();
});

describe('shares sidebar write bodies', () => {
	it('supplies the required scope when creating a share', async () => {
		const wrapper = mountShares();
		await flushPromises();

		wrapper.findComponent(VButton).vm.$emit('click');
		await flushPromises();

		expect(drawer(wrapper).props('primaryKey')).toBe('+');

		drawer(wrapper).vm.$emit('input', { name: 'Link' });
		await flushPromises();

		expect(apiPost).toHaveBeenCalledWith('/shares', { name: 'Link', collection: 'articles', item: 1 });
	});

	it('preserves a valid zero-input create through the required scope', async () => {
		const wrapper = mountShares();
		await flushPromises();

		wrapper.findComponent(VButton).vm.$emit('click');
		await flushPromises();

		drawer(wrapper).vm.$emit('input', {});
		await flushPromises();

		expect(apiPost).toHaveBeenCalledWith('/shares', { collection: 'articles', item: 1 });
	});

	it('renames a share without re-asserting scope or the selector', async () => {
		apiGet.mockResolvedValue({ data: { data: [existingShare] } });

		const wrapper = mountShares();
		await flushPromises();

		wrapper.findComponent(ShareItem).vm.$emit('edit');
		await flushPromises();

		expect(drawer(wrapper).props('primaryKey')).toBe(shareId);

		drawer(wrapper).vm.$emit('input', { name: 'New', id: shareId });
		await flushPromises();

		expect(apiPatch).toHaveBeenCalledWith(`/shares/${shareId}`, { name: 'New' });
	});
});
