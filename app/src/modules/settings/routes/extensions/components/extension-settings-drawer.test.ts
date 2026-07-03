import api from '@/api';
import { i18n } from '@/lang';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ExtensionSettingsDrawer from './extension-settings-drawer.vue';

vi.mock('@/api', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@/utils/unexpected-error', () => ({ unexpectedError: vi.fn() }));

const { addNotification } = vi.hoisted(() => ({ addNotification: vi.fn() }));
vi.mock('@/stores/notifications', () => ({ useNotificationsStore: () => ({ add: addNotification }) }));

const stubs = {
	'v-drawer': {
		props: ['modelValue', 'title', 'subtitle'],
		template: '<div class="v-drawer"><slot /><slot name="actions" /></div>',
	},
	'v-notice': { props: ['type'], template: '<div class="v-notice" :data-type="type"><slot /></div>' },
	'v-progress-circular': { template: '<div class="loading" />' },
	'v-form': {
		name: 'v-form',
		props: ['fields', 'initialValues', 'modelValue'],
		emits: ['update:modelValue'],
		template: '<div class="v-form" />',
	},
	'v-button': {
		props: ['disabled', 'loading'],
		emits: ['click'],
		template: '<button class="save" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
	},
	'v-icon': { props: ['name'], template: '<i :data-name="name"></i>' },
};

const declaration = {
	base_url: { type: 'string', scope: 'global', presentation: { order: 1, width: 'full' } },
	retries: { type: 'number', scope: 'global', presentation: { order: 2, width: 'half' } },
	verbose: { type: 'boolean', scope: 'global', presentation: { order: 3, width: 'half' } },
	api_key: { type: 'string', scope: 'global', secret: { source: 'inline' }, presentation: { order: 4, width: 'full' } },
	billing_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
	preview_url: { type: 'string', scope: 'collection', appReadable: true },
};

const resolveDeclaration = vi.fn();

function mountDrawer(settings: any = { status: 'available' }) {
	return mount(ExtensionSettingsDrawer, {
		props: { modelValue: true, subject: 'cairncms-extension-demo', settings, resolveDeclaration },
		global: { plugins: [i18n], stubs, directives: { tooltip: {} } },
	});
}

function mockLoad() {
	resolveDeclaration.mockResolvedValue(declaration);

	vi.mocked(api.get).mockResolvedValue({
		data: {
			data: [
				{ scope: 'global', scope_key: '', key: 'base_url', value: 'https://x' },
				{ scope: 'global', scope_key: '', key: 'api_key', value: '**********' },
			],
		},
	} as any);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('extension settings drawer', () => {
	it('synthesizes only the editable global keys, ordered and sized, with the secret interface', async () => {
		mockLoad();

		const wrapper = mountDrawer();
		await flushPromises();

		const form = wrapper.findComponent({ name: 'v-form' });
		const fields = form.props('fields') as any[];

		expect(fields.map((field) => field.field)).toEqual(['base_url', 'retries', 'verbose', 'api_key']);
		expect(fields.map((field) => field.meta.width)).toEqual(['full', 'half', 'half', 'full']);
		expect(fields.map((field) => field.meta.interface)).toEqual([
			'input',
			'input',
			'boolean',
			'system-extension-secret',
		]);

		expect(fields[0].name).toBe('Base URL');

		expect(form.props('initialValues')).toEqual({ base_url: 'https://x', api_key: '**********' });
	});

	it('shows the generic config notice and never a derived variable name', async () => {
		mockLoad();

		const wrapper = mountDrawer();
		await flushPromises();

		const notices = wrapper.findAll('.v-notice[data-type="info"]');
		expect(notices.some((notice) => notice.text().includes('deployment configuration'))).toBe(true);

		expect(wrapper.html()).not.toContain('CAIRNCMS_EXT_');
		expect(wrapper.html()).not.toContain('billing_key');
	});

	it('saves each changed key, posting values and deleting nulls, then closes', async () => {
		mockLoad();
		vi.mocked(api.post).mockResolvedValue({} as any);
		vi.mocked(api.delete).mockResolvedValue({} as any);

		const wrapper = mountDrawer();
		await flushPromises();

		wrapper.findComponent({ name: 'v-form' }).vm.$emit('update:modelValue', {
			base_url: 'https://y',
			retries: null,
		});

		await nextTick();
		await wrapper.find('button.save').trigger('click');
		await flushPromises();

		expect(api.post).toHaveBeenCalledTimes(1);

		expect(api.post).toHaveBeenCalledWith('/extension-settings', {
			subject: 'cairncms-extension-demo',
			scope: 'global',
			scope_key: '',
			key: 'base_url',
			value: 'https://y',
		});

		expect(api.delete).toHaveBeenCalledTimes(1);

		expect(api.delete).toHaveBeenCalledWith('/extension-settings', {
			data: { subject: 'cairncms-extension-demo', scope: 'global', scope_key: '', key: 'retries' },
		});

		expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false]);
	});

	it('surfaces the encryption-key precondition as the operator message, not a raw error', async () => {
		mockLoad();

		vi.mocked(api.post).mockRejectedValue({
			response: { data: { errors: [{ extensions: { code: 'INVALID_CONFIG' } }] } },
		});

		const wrapper = mountDrawer();
		await flushPromises();

		wrapper.findComponent({ name: 'v-form' }).vm.$emit('update:modelValue', { api_key: 'sk_live_new' });
		await nextTick();
		await wrapper.find('button.save').trigger('click');
		await flushPromises();

		expect(addNotification).toHaveBeenCalledWith(
			expect.objectContaining({ title: expect.stringContaining('encryption key is not configured') })
		);

		expect(wrapper.emitted('update:modelValue')).toBeUndefined();
	});

	it('fails closed to the load error when an available owner has no resolvable declaration', async () => {
		resolveDeclaration.mockResolvedValue(undefined);

		vi.mocked(api.get).mockResolvedValue({ data: { data: [] } } as any);

		const wrapper = mountDrawer();
		await flushPromises();

		expect(wrapper.find('.v-form').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('declares no global settings');

		const notice = wrapper.find('.v-notice[data-type="danger"]');
		expect(notice.exists()).toBe(true);
		expect(notice.text()).toContain("Could not load the extension's settings");
	});

	it('renders the reason only, with no form and no save, for an unavailable owner', async () => {
		const wrapper = mountDrawer({
			status: 'unavailable',
			reason: { code: 'settings-subject-duplicate', detail: 'the settings subject "x" is declared by more than one extension' },
		});

		await flushPromises();

		expect(api.get).not.toHaveBeenCalled();
		expect(resolveDeclaration).not.toHaveBeenCalled();
		expect(wrapper.find('.v-form').exists()).toBe(false);
		expect(wrapper.find('button.save').exists()).toBe(false);

		const notice = wrapper.find('.v-notice[data-type="warning"]');
		expect(notice.text()).toContain('More than one installed extension uses this package name');
	});

});
