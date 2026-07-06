import api from '@/api';
import { i18n } from '@/lang';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExtensionCollectionSettings from './extension-collection-settings.vue';

vi.mock('@/api', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@/utils/unexpected-error', () => ({ unexpectedError: vi.fn() }));

const { addNotification } = vi.hoisted(() => ({ addNotification: vi.fn() }));
vi.mock('@/stores/notifications', () => ({ useNotificationsStore: () => ({ add: addNotification }) }));

const stubs = {
	'v-form': {
		name: 'v-form',
		props: ['fields', 'initialValues', 'modelValue'],
		emits: ['update:modelValue'],
		template: '<div class="v-form" />',
	},
	'v-divider': { template: '<div class="section-head"><slot /></div>' },
	'v-icon': { props: ['name'], template: '<i :data-name="name"></i>' },
};

const owners = [
	{
		subject: 'cairncms-extension-preview',
		displaySubject: 'cairncms-extension-preview',
		status: 'available',
		declaration: {
			preview_url: { type: 'string', scope: 'collection', presentation: { order: 2 } },
			banner: { type: 'string', scope: 'collection', presentation: { order: 1 } },
			secret_token: { type: 'string', scope: 'collection', secret: { source: 'inline' }, presentation: { order: 3 } },
			base_url: { type: 'string', scope: 'global' },
		},
	},
	{
		subject: 'cairncms-extension-global-only',
		displaySubject: 'cairncms-extension-global-only',
		status: 'available',
		declaration: { theme: { type: 'string', scope: 'global' } },
	},
	{
		subject: 'cairncms-extension-broken',
		displaySubject: 'cairncms-extension-broken',
		status: 'unavailable',
		declaration: { stale_key: { type: 'string', scope: 'collection' } },
	},
];

function mockLoad() {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === '/extension-settings/owners') return { data: { data: owners } } as any;

		return {
			data: { data: [{ scope: 'collection', scope_key: 'articles', key: 'preview_url', value: 'https://p' }] },
		} as any;
	});
}

function mountBlock(collection = 'articles') {
	return mount(ExtensionCollectionSettings, {
		props: { collection },
		global: { plugins: [i18n], stubs },
	});
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('extension collection settings', () => {
	it('lists only available owners with collection keys, ordered, loading only the edited collection', async () => {
		mockLoad();

		const wrapper = mountBlock();
		await flushPromises();

		expect(wrapper.find('.section-head').text()).toContain('Extension Settings');

		const ownerTitles = wrapper.findAll('.owner-title').map((node) => node.text());
		expect(ownerTitles).toEqual(['Preview']);

		const forms = wrapper.findAllComponents({ name: 'v-form' });
		expect(forms).toHaveLength(1);

		const fields = forms[0]!.props('fields') as any[];
		expect(fields.map((field) => field.field)).toEqual(['banner', 'preview_url', 'secret_token']);
		expect(fields.map((field) => field.meta.interface)).toEqual(['input', 'input', 'system-extension-secret']);

		expect(forms[0]!.props('initialValues')).toEqual({ preview_url: 'https://p' });

		expect(api.get).toHaveBeenCalledWith('/extension-settings', {
			params: { subject: 'cairncms-extension-preview', scope: 'collection', scope_key: 'articles' },
		});

		expect(api.get).not.toHaveBeenCalledWith('/extension-settings', {
			params: expect.objectContaining({ subject: 'cairncms-extension-broken' }),
		});
	});

	it('saves under the collection scope, clearing nulls and never posting a stale mask', async () => {
		mockLoad();
		vi.mocked(api.post).mockResolvedValue({} as any);
		vi.mocked(api.delete).mockResolvedValue({} as any);

		const wrapper = mountBlock();
		await flushPromises();

		expect(wrapper.vm.hasEdits).toBe(false);

		wrapper.findComponent({ name: 'v-form' }).vm.$emit('update:modelValue', {
			banner: 'hero.svg',
			preview_url: null,
			secret_token: '**********',
		});

		expect(wrapper.vm.hasEdits).toBe(true);

		const saved = await wrapper.vm.save();
		await flushPromises();

		expect(saved).toBe(true);
		expect(api.post).toHaveBeenCalledTimes(1);

		expect(api.post).toHaveBeenCalledWith('/extension-settings', {
			subject: 'cairncms-extension-preview',
			scope: 'collection',
			scope_key: 'articles',
			key: 'banner',
			value: 'hero.svg',
		});

		expect(api.delete).toHaveBeenCalledTimes(1);

		expect(api.delete).toHaveBeenCalledWith('/extension-settings', {
			data: { subject: 'cairncms-extension-preview', scope: 'collection', scope_key: 'articles', key: 'preview_url' },
		});

		expect(wrapper.vm.hasEdits).toBe(false);
	});

	it('returns false from save and raises the operator message on the key precondition', async () => {
		mockLoad();

		vi.mocked(api.post).mockRejectedValue({
			response: { data: { errors: [{ extensions: { code: 'INVALID_CONFIG' } }] } },
		});

		const wrapper = mountBlock();
		await flushPromises();

		wrapper.findComponent({ name: 'v-form' }).vm.$emit('update:modelValue', { secret_token: 'sk_new' });

		const saved = await wrapper.vm.save();

		expect(saved).toBe(false);

		expect(addNotification).toHaveBeenCalledWith(
			expect.objectContaining({ title: expect.stringContaining('encryption key is not configured') })
		);
	});

	it('renders the derived title only, one group per scoped owner sharing a local name', async () => {
		const scopedOwners = ['@acme', '@vendor'].map((scope) => ({
			subject: `${scope}/cairncms-extension-preview`,
			displaySubject: `${scope}/cairncms-extension-preview`,
			status: 'available',
			declaration: { preview_url: { type: 'string', scope: 'collection' } },
		}));

		vi.mocked(api.get).mockImplementation(async (path: string) => {
			if (path === '/extension-settings/owners') return { data: { data: scopedOwners } } as any;
			return { data: { data: [] } } as any;
		});

		const wrapper = mountBlock();
		await flushPromises();

		expect(wrapper.findAll('.owner-title').map((node) => node.text())).toEqual(['Preview', 'Preview']);
		expect(wrapper.find('.package-name').exists()).toBe(false);
	});

	it('clears edits on discard', async () => {
		mockLoad();

		const wrapper = mountBlock();
		await flushPromises();

		wrapper.findComponent({ name: 'v-form' }).vm.$emit('update:modelValue', { banner: 'x' });
		expect(wrapper.vm.hasEdits).toBe(true);

		wrapper.vm.discard();
		expect(wrapper.vm.hasEdits).toBe(false);
	});

	it('ignores a stale load that resolves after the collection changed', async () => {
		const pendingOwners: ((value: any) => void)[] = [];

		vi.mocked(api.get).mockImplementation((path: string) => {
			if (path === '/extension-settings/owners') {
				return new Promise((resolve) => pendingOwners.push(resolve)) as any;
			}

			return Promise.resolve({ data: { data: [] } }) as any;
		});

		const wrapper = mountBlock('articles');
		await wrapper.setProps({ collection: 'orders' });

		expect(pendingOwners).toHaveLength(2);

		pendingOwners[1]!({ data: { data: owners } });
		await flushPromises();

		pendingOwners[0]!({ data: { data: owners } });
		await flushPromises();

		const valueCalls = vi.mocked(api.get).mock.calls.filter(([path]) => path === '/extension-settings');
		expect(valueCalls).toHaveLength(1);

		expect(valueCalls[0]![1]).toEqual({
			params: { subject: 'cairncms-extension-preview', scope: 'collection', scope_key: 'orders' },
		});
	});

	it('never queries for a system collection', async () => {
		mockLoad();

		const wrapper = mountBlock('directus_users');
		await flushPromises();

		expect(api.get).not.toHaveBeenCalled();
		expect(wrapper.find('.extension-collection-settings').exists()).toBe(false);
	});
});
