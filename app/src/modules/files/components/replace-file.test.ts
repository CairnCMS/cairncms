import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import type { ItemPermissions, Permission } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { createI18n } from 'vue-i18n';

const FILE_A = '11111111-1111-4111-8111-111111111111';
const FILE_B = '22222222-2222-4222-8222-222222222222';
const REPLACE_FIELDS = ['folder', 'filename_download', 'storage', 'type'];

const apiGet = vi.fn<(path: string) => Promise<unknown>>();
const apiPost = vi.fn();
const apiPatch = vi.fn();

vi.mock('@/api', () => ({
	default: {
		get: (path: string) => apiGet(path),
		post: (...args: unknown[]) => apiPost(...args),
		patch: (...args: unknown[]) => apiPatch(...args),
	},
}));

vi.mock('@/utils/upload-files', () => ({ uploadFiles: vi.fn() }));
vi.mock('@/utils/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lang', () => ({ i18n: { global: { t: vi.fn(() => '') } } }));
vi.mock('@/utils/unexpected-error', () => ({ unexpectedError: vi.fn() }));
vi.mock('@/events', () => ({ default: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }, Events: { upload: 'upload' } }));

vi.mock('@/views/private/components/drawer-files.vue', () => ({
	default: { name: 'DrawerFiles', template: '<div />' },
}));

import ReplaceFile from './replace-file.vue';
import VUploadReal from '@/components/v-upload.vue';

enableAutoUnmount(afterEach);

const i18n = createI18n({ legacy: false });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => (resolve = res));
	return { promise, resolve };
}

// eslint-disable-next-line vue/one-component-per-file
const VUpload = defineComponent({
	name: 'VUpload',
	props: { fileId: { type: String, default: null } },
	emits: ['input'],
	template: '<div class="v-upload-stub" :data-file-id="fileId" />',
});

const stubs = {
	'v-dialog': { props: ['modelValue'], template: '<div><slot /></div>' },
	'v-card': { template: '<div><slot /></div>' },
	'v-card-title': { template: '<div><slot /></div>' },
	'v-card-text': { template: '<div><slot /></div>' },
	'v-card-actions': { template: '<div><slot /></div>' },
	'v-button': { template: '<button><slot /></button>' },
	'v-notice': { template: '<div class="v-notice"><slot /></div>' },
};

function cap(access: boolean, fields: string[] | null): ItemPermissions {
	return { update: { access, fields }, delete: { access: false }, share: { access: false } };
}

function perm(conditional: boolean, fields: string[] | null): Permission {
	return {
		role: 'role-1',
		collection: 'directus_files',
		action: 'update',
		permissions: conditional ? { uploaded_by: { _eq: '$CURRENT_USER' } } : {},
		validation: null,
		presets: null,
		fields,
	};
}

function mountReplace(
	options: {
		admin?: boolean;
		permissions?: Permission[];
		capability?: ItemPermissions | null;
		capabilityDeferred?: ReturnType<typeof deferred<{ data: { data: ItemPermissions } }>>;
	} = {}
) {
	apiGet.mockImplementation((path: string) => {
		if (path.startsWith('/permissions/me')) {
			if (options.capabilityDeferred) return options.capabilityDeferred.promise;
			return Promise.resolve({ data: { data: options.capability ?? null } });
		}

		return Promise.reject(new Error(`GET "${path}" is not mocked`));
	});

	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { id: 'user-1', role: { id: 'role-1', admin_access: options.admin ?? false } };
	(usePermissionsStore() as any).permissions = options.permissions ?? [];

	return mount(ReplaceFile, {
		props: { modelValue: true, file: { id: FILE_A }, preset: {} },
		global: { plugins: [i18n, pinia], stubs, components: { VUpload }, directives: { tooltip: {} } },
	});
}

function uploadPresent(wrapper: ReturnType<typeof mountReplace>) {
	return wrapper.findComponent(VUpload).exists();
}

function capabilityRequests() {
	return apiGet.mock.calls.filter(([path]) => path.startsWith('/permissions/me')).length;
}

beforeEach(() => {
	apiGet.mockReset();
	apiPost.mockReset();
	apiPatch.mockReset();
});

describe('replace-file gating', () => {
	it('offers the upload to an admin without a capability request', async () => {
		const wrapper = mountReplace({ admin: true });
		await flushPromises();

		expect(capabilityRequests()).toBe(0);
		expect(uploadPresent(wrapper)).toBe(true);
		expect(wrapper.findComponent(VUpload).props('fileId')).toBe(FILE_A);
	});

	it('offers the upload for an unconditional grant covering the replace fields', async () => {
		const wrapper = mountReplace({ permissions: [perm(false, REPLACE_FIELDS)] });
		await flushPromises();

		expect(capabilityRequests()).toBe(0);
		expect(uploadPresent(wrapper)).toBe(true);
	});

	it('withholds the upload for a foreign file under a conditional grant', async () => {
		const wrapper = mountReplace({ permissions: [perm(true, ['*'])], capability: cap(false, null) });
		await flushPromises();

		expect(apiGet).toHaveBeenCalledWith(`/permissions/me/directus_files/${FILE_A}`);
		expect(uploadPresent(wrapper)).toBe(false);
		expect(wrapper.find('.v-notice').exists()).toBe(true);
	});

	it('offers the upload for an owned file whose conditional grant covers the replace fields', async () => {
		const wrapper = mountReplace({ permissions: [perm(true, ['*'])], capability: cap(true, REPLACE_FIELDS) });
		await flushPromises();

		expect(uploadPresent(wrapper)).toBe(true);
	});

	it('withholds the upload when the conditional grant lacks a required replace field', async () => {
		const wrapper = mountReplace({ permissions: [perm(true, ['*'])], capability: cap(true, ['title']) });
		await flushPromises();

		expect(uploadPresent(wrapper)).toBe(false);
	});

	it('withholds the upload until the conditional capability resolves', async () => {
		const pending = deferred<{ data: { data: ItemPermissions } }>();
		const wrapper = mountReplace({ permissions: [perm(true, ['*'])], capabilityDeferred: pending });
		await flushPromises();

		expect(uploadPresent(wrapper)).toBe(false);

		pending.resolve({ data: { data: cap(true, ['*']) } });
		await flushPromises();

		expect(uploadPresent(wrapper)).toBe(true);
	});

	it('closes and reports a completion for the current target', async () => {
		const wrapper = mountReplace({ admin: true });
		await flushPromises();

		wrapper.findComponent(VUpload).vm.$emit('input', { id: FILE_A });
		await flushPromises();

		expect((wrapper.emitted('update:modelValue') ?? []).some(([value]) => value === false)).toBe(true);
		expect(wrapper.emitted('replaced')).toHaveLength(1);
	});

	it('ignores a completion whose file does not match the current target', async () => {
		const wrapper = mountReplace({ admin: true });
		await flushPromises();

		await wrapper.setProps({ file: { id: FILE_B } });
		await flushPromises();

		wrapper.findComponent(VUpload).vm.$emit('input', { id: FILE_A });
		await flushPromises();

		expect(wrapper.emitted('replaced')).toBeUndefined();

		wrapper.findComponent(VUpload).vm.$emit('input', { id: FILE_B });
		await flushPromises();

		expect(wrapper.emitted('replaced')).toHaveLength(1);
	});

	function mountWired(fileId = FILE_A, { conditionalDialog = false } = {}) {
		const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
		setActivePinia(pinia);
		(useUserStore() as any).currentUser = { id: 'user-1', role: { id: 'role-1', admin_access: true } };
		(usePermissionsStore() as any).permissions = [];
		apiGet.mockResolvedValue({ data: { data: null } });

		return mount(ReplaceFile, {
			props: { modelValue: true, file: { id: fileId }, preset: {} },
			global: {
				plugins: [i18n, pinia],
				components: { VUpload: VUploadReal },
				stubs: {
					'v-dialog': {
						props: ['modelValue'],
						template: conditionalDialog ? '<div v-if="modelValue"><slot /></div>' : '<div><slot /></div>',
					},
					'v-card': { template: '<div><slot /></div>' },
					'v-card-title': { template: '<div><slot /></div>' },
					'v-card-text': { template: '<div><slot /></div>' },
					'v-card-actions': { template: '<div><slot /></div>' },
					'v-button': {
						inheritAttrs: false,
						emits: ['click'],
						template: '<button @click="$emit(\'click\')"><slot /></button>',
					},
					'v-icon': { template: '<i />' },
					'v-input': {
						props: ['modelValue'],
						emits: ['update:modelValue'],
						template:
							'<input class="url-input" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
					},
					'v-progress-linear': { template: '<div />' },
					'v-notice': { template: '<div class="v-notice"><slot /></div>' },
				},
				directives: { tooltip: {} },
			},
		});
	}

	async function startMultipart(wrapper: ReturnType<typeof mountWired>) {
		const input = wrapper.find('input.browse');

		Object.defineProperty(input.element, 'files', {
			configurable: true,
			value: [new File(['x'], 'replacement.png', { type: 'image/png' })],
		});

		await input.trigger('input');
		await flushPromises();
	}

	async function importUrl(wrapper: ReturnType<typeof mountWired>, url: string) {
		await wrapper.find('input.url-input').setValue(url);
		const importButton = wrapper.findAll('button').find((button) => button.text() === 'import_label');
		await importButton!.trigger('click');
		await flushPromises();
	}

	it('closes the dialog when a multipart replace returns 204', async () => {
		apiPatch.mockResolvedValue({ status: 204, data: '' });

		const wrapper = mountWired();
		await flushPromises();
		await startMultipart(wrapper);

		expect(apiPatch).toHaveBeenCalledWith(`/files/${FILE_A}`, expect.anything(), expect.anything());
		expect((wrapper.emitted('update:modelValue') ?? []).some(([value]) => value === false)).toBe(true);
		expect(wrapper.emitted('replaced')).toHaveLength(1);
	});

	it('does not complete a switched target with a stale URL response', async () => {
		const pending = deferred<{ status: number; data: unknown }>();
		apiPost.mockReturnValue(pending.promise);

		const wrapper = mountWired(FILE_A);
		await flushPromises();

		await importUrl(wrapper, 'https://example.com/a.png');

		await wrapper.setProps({ file: { id: FILE_B } });
		await flushPromises();

		pending.resolve({ status: 204, data: '' });
		await flushPromises();

		expect(wrapper.emitted('replaced')).toBeUndefined();
	});

	it('closes the dialog when a URL replace returns 204 and sends the target id', async () => {
		apiPost.mockResolvedValue({ status: 204, data: '' });

		const wrapper = mountWired();
		await flushPromises();
		await importUrl(wrapper, 'https://example.com/a.png');

		expect(apiPost).toHaveBeenCalledWith('/files/import', {
			url: 'https://example.com/a.png',
			data: { folder: undefined, id: FILE_A },
		});

		expect(apiPost).toHaveBeenCalledTimes(1);
		expect((wrapper.emitted('update:modelValue') ?? []).some(([value]) => value === false)).toBe(true);
		expect(wrapper.emitted('replaced')).toHaveLength(1);
	});

	it('does not close the dialog when a URL replace fails', async () => {
		apiPost.mockRejectedValue(new Error('boom'));

		const wrapper = mountWired();
		await flushPromises();
		await importUrl(wrapper, 'https://example.com/a.png');

		expect(wrapper.emitted('replaced')).toBeUndefined();
		expect((wrapper.emitted('update:modelValue') ?? []).some(([value]) => value === false)).toBe(false);
	});

	it('does not complete a switched target with a stale multipart response, then completes the new one', async () => {
		const first = deferred<{ status: number; data: unknown }>();
		const second = deferred<{ status: number; data: unknown }>();
		apiPatch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const wrapper = mountWired(FILE_A);
		await flushPromises();

		await startMultipart(wrapper);
		expect(apiPatch).toHaveBeenLastCalledWith(`/files/${FILE_A}`, expect.anything(), expect.anything());

		await wrapper.setProps({ file: { id: FILE_B } });
		await flushPromises();

		first.resolve({ status: 204, data: '' });
		await flushPromises();
		expect(wrapper.emitted('replaced')).toBeUndefined();

		await startMultipart(wrapper);
		expect(apiPatch).toHaveBeenLastCalledWith(`/files/${FILE_B}`, expect.anything(), expect.anything());

		second.resolve({ status: 204, data: '' });
		await flushPromises();
		expect(wrapper.emitted('replaced')).toHaveLength(1);
	});

	it('ignores a stale completion from a session closed and reopened on the same target', async () => {
		const first = deferred<{ status: number; data: unknown }>();
		const second = deferred<{ status: number; data: unknown }>();
		apiPatch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const wrapper = mountWired(FILE_A, { conditionalDialog: true });
		await flushPromises();

		await startMultipart(wrapper);

		await wrapper.setProps({ modelValue: false });
		await flushPromises();
		await wrapper.setProps({ modelValue: true });
		await flushPromises();

		await startMultipart(wrapper);

		first.resolve({ status: 204, data: '' });
		await flushPromises();
		expect(wrapper.emitted('replaced')).toBeUndefined();

		second.resolve({ status: 204, data: '' });
		await flushPromises();
		expect(wrapper.emitted('replaced')).toHaveLength(1);
	});
});
