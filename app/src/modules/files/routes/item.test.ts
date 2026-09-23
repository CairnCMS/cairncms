import { STORES_INJECT } from '@cairncms/constants';
import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { useUserStore } from '@/stores/user';

const shortcuts = new Map<string, () => void>();
const saveSpy = vi.fn(() => Promise.resolve({ id: '1' }));
const routerPush = vi.fn();
const routerReplace = vi.fn();

const gates = {
	saveAllowed: ref(true),
	hasEdits: ref(true),
	isNew: ref(false),
};

vi.mock('@/composables/use-shortcut', () => ({
	useShortcut: (keys: string, handler: () => void) => {
		shortcuts.set(keys, handler);
	},
}));

vi.mock('@/composables/use-item', () => ({
	useItem: () => ({
		isNew: gates.isNew,
		isNewOrEmptySingleton: ref(false),
		edits: ref({}),
		hasEdits: gates.hasEdits,
		item: ref({
			id: '1',
			type: 'application/pdf',
			title: 'File',
			filename_download: 'file.pdf',
			width: null,
			height: null,
		}),
		saving: ref(false),
		loading: ref(false),
		error: ref(null),
		save: saveSpy,
		remove: vi.fn(),
		deleting: ref(false),
		saveAsCopy: vi.fn(),
		isBatch: ref(false),
		refresh: vi.fn(),
		validationErrors: ref([]),
	}),
}));

vi.mock('@/composables/use-permissions', () => ({
	usePermissions: () => ({
		createAllowed: ref(true),
		deleteAllowed: ref(true),
		saveAllowed: gates.saveAllowed,
		updateAllowed: ref(true),
		fields: ref([]),
		revisionsAllowed: ref(true),
	}),
}));

vi.mock('@/composables/use-edits-guard', () => ({
	useEditsGuard: () => ({ confirmLeave: ref(false), leaveTo: ref(null) }),
}));

vi.mock('vue-router', async (importOriginal) => ({
	...(await importOriginal<typeof import('vue-router')>()),
	useRouter: () => ({ push: routerPush, replace: routerReplace, options: { history: { state: {} } } }),
	useRoute: () => ({ params: {}, query: {} }),
	onBeforeRouteLeave: vi.fn(),
	onBeforeRouteUpdate: vi.fn(),
}));

vi.mock('@cairncms/composables', () => ({
	useCollection: () => ({ info: ref({ meta: {} }), fields: ref([]), primaryKeyField: ref({ field: 'id' }) }),
}));

vi.mock('@/api', () => ({
	default: {
		get: vi.fn(() => Promise.resolve({ data: { data: {} } })),
		post: vi.fn(),
		patch: vi.fn(),
	},
}));

import FilesItem from './item.vue';

enableAutoUnmount(afterEach);

const i18n = createI18n({ legacy: false });

// eslint-disable-next-line vue/one-component-per-file
const VButton = defineComponent({
	name: 'VButton',
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /><slot name="append-outer" /></button>',
});

// eslint-disable-next-line vue/one-component-per-file
const VIcon = defineComponent({
	name: 'VIcon',
	props: { name: { type: String, default: '' } },
	template: '<i :data-name="name" />',
});

const PrivateView = { template: '<div><slot /><slot name="title-outer:prepend" /><slot name="actions" /></div>' };

const otherStubs = [
	'v-breadcrumb',
	'v-card',
	'v-card-actions',
	'v-card-text',
	'v-card-title',
	'v-chip',
	'v-dialog',
	'v-form',
	'v-image',
	'v-menu',
	'v-skeleton-loader',
	'v-upload',
	'save-options',
].reduce((stubs, name) => ({ ...stubs, [name]: true }), {} as Record<string, boolean>);

function mountItem() {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { id: 'someone-else', role: { id: 'r', admin_access: false } };

	return shallowMount(FilesItem, {
		props: { primaryKey: '1' },
		global: {
			plugins: [i18n, pinia],
			provide: STORES_INJECT,
			stubs: { 'private-view': PrivateView, 'v-button': VButton, 'v-icon': VIcon, ...otherStubs },
			directives: { tooltip: {} },
		},
	});
}

function saveButton(wrapper: ReturnType<typeof mountItem>) {
	return wrapper.findAllComponents(VButton).find((button) => button.html().includes('data-name="check"'))!;
}

beforeEach(() => {
	shortcuts.clear();
	saveSpy.mockClear();
	routerPush.mockClear();
	routerReplace.mockClear();
	gates.saveAllowed.value = true;
	gates.hasEdits.value = true;
	gates.isNew.value = false;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('files item save availability', () => {
	it('does not save through the save shortcut when saving is not allowed', async () => {
		gates.saveAllowed.value = false;

		mountItem();

		shortcuts.get('meta+s')!();
		await flushPromises();

		expect(saveSpy).not.toHaveBeenCalled();
		expect(routerPush).not.toHaveBeenCalled();
	});

	it('does not save through the save button when saving is not allowed', async () => {
		gates.saveAllowed.value = false;

		const wrapper = mountItem();

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(saveSpy).not.toHaveBeenCalled();
		expect(routerPush).not.toHaveBeenCalled();
	});

	it('does not save through the save shortcut when there are no edits', async () => {
		gates.hasEdits.value = false;

		mountItem();

		shortcuts.get('meta+s')!();
		await flushPromises();

		expect(saveSpy).not.toHaveBeenCalled();
	});

	it('saves and quits through the save button when savable', async () => {
		const wrapper = mountItem();

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(saveSpy).toHaveBeenCalledTimes(1);
		expect(routerPush).toHaveBeenCalledWith('/files');
	});

	it('saves and stays through the shortcut when savable', async () => {
		mountItem();

		shortcuts.get('meta+s')!();
		await flushPromises();

		expect(saveSpy).toHaveBeenCalledTimes(1);
	});
});
