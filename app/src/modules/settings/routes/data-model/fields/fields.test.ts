import { i18n } from '@/lang';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import FieldsPage from './fields.vue';

const holders = vi.hoisted(() => ({
	guard: {} as any,
	itemSave: vi.fn(),
	routerPush: vi.fn(),
	childSave: vi.fn(),
	childDiscard: vi.fn(),
}));

vi.mock('@/composables/use-edits-guard', async () => {
	const { ref } = await import('vue');

	return {
		useEditsGuard: (hasEdits: any) => {
			holders.guard.hasEdits = hasEdits;
			holders.guard.confirmLeave ??= ref(false);
			holders.guard.leaveTo ??= ref(null);
			return { confirmLeave: holders.guard.confirmLeave, leaveTo: holders.guard.leaveTo };
		},
	};
});

vi.mock('@/composables/use-item', async () => {
	const { ref } = await import('vue');

	return {
		useItem: () => ({
			edits: ref<Record<string, any>>({}),
			item: ref({ collection: 'articles', meta: {} }),
			saving: ref(false),
			loading: ref(false),
			save: holders.itemSave,
			remove: vi.fn(),
			deleting: ref(false),
			isBatch: ref(false),
		}),
	};
});

vi.mock('@/composables/use-shortcut', () => ({ useShortcut: vi.fn() }));
vi.mock('@/stores/collections', () => ({ useCollectionsStore: () => ({ hydrate: vi.fn() }) }));
vi.mock('@/stores/fields', () => ({ useFieldsStore: () => ({ hydrate: vi.fn() }) }));

vi.mock('@cairncms/composables', () => ({
	useCollection: () => ({ info: ref({ name: 'Articles' }) }),
}));

vi.mock('vue-router', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	useRouter: () => ({ push: holders.routerPush, replace: vi.fn() }),
}));

const childHasEdits = ref(false);

const ExtensionCollectionSettingsStub = defineComponent({
	name: 'ExtensionCollectionSettings',
	props: { collection: { type: String, required: true } },
	setup(_, { expose }) {
		expose({ hasEdits: childHasEdits, save: holders.childSave, discard: holders.childDiscard });
		return () => h('div', { class: 'extension-collection-settings-stub' });
	},
});

function mountPage() {
	return mount(FieldsPage, {
		props: { collection: 'articles' },
		shallow: true,
		global: {
			plugins: [i18n],
			renderStubDefaultSlot: true,
			stubs: {
				'extension-collection-settings': ExtensionCollectionSettingsStub,
				'private-view': {
					template: '<div class="private-view"><slot name="actions" /><slot /></div>',
				},
				'v-dialog': { template: '<div class="v-dialog"><slot /></div>' },
				'v-card': { template: '<div class="v-card"><slot /></div>' },
				'v-card-title': { template: '<div class="v-card-title"><slot /></div>' },
				'v-card-text': { template: '<div class="v-card-text"><slot /></div>' },
				'v-card-actions': { template: '<div class="v-card-actions"><slot /></div>' },
				'v-button': {
					props: ['disabled', 'loading'],
					emits: ['click'],
					template: '<button class="v-button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
				'v-icon': { template: '<i />' },
			},
			directives: { tooltip: {}, md: {} },
		},
	});
}

afterEach(() => {
	vi.clearAllMocks();
	childHasEdits.value = false;
});

describe('data model fields page and extension settings integration', () => {
	it('counts extension edits into the page dirty state and the leave guard', async () => {
		const wrapper = mountPage();
		await flushPromises();

		expect(holders.guard.hasEdits.value).toBe(false);
		expect(wrapper.find('.action-save').attributes('disabled')).toBeDefined();

		childHasEdits.value = true;
		await flushPromises();

		expect(holders.guard.hasEdits.value).toBe(true);
		expect(wrapper.find('.action-save').attributes('disabled')).toBeUndefined();
	});

	it('blocks quit navigation when the extension save fails and never saves an unedited collection', async () => {
		childHasEdits.value = true;
		holders.childSave.mockResolvedValue(false);

		const wrapper = mountPage();
		await flushPromises();

		await wrapper.find('.action-save').trigger('click');
		await flushPromises();

		expect(holders.childSave).toHaveBeenCalledTimes(1);
		expect(holders.itemSave).not.toHaveBeenCalled();
		expect(holders.routerPush).not.toHaveBeenCalled();
	});

	it('navigates after a successful extension save', async () => {
		childHasEdits.value = true;
		holders.childSave.mockResolvedValue(true);

		const wrapper = mountPage();
		await flushPromises();

		await wrapper.find('.action-save').trigger('click');
		await flushPromises();

		expect(holders.routerPush).toHaveBeenCalledWith('/settings/data-model');
	});

	it('discards extension edits from the unsaved-changes dialog', async () => {
		const wrapper = mountPage();
		await flushPromises();

		holders.guard.leaveTo.value = '/settings/data-model';
		holders.guard.confirmLeave.value = true;
		await flushPromises();

		const discardButton = wrapper.findAll('button.v-button').find((node) => node.text().includes('Discard Changes'));

		expect(discardButton).toBeDefined();

		await discardButton!.trigger('click');

		expect(holders.childDiscard).toHaveBeenCalledTimes(1);
		expect(holders.routerPush).toHaveBeenCalledWith('/settings/data-model');
	});
});
