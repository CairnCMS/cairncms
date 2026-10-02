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

const { toBlobCallbacks, readyCallbacks, CropperMock, setCropperReady } = vi.hoisted(() => {
	const callbacks: Array<(blob: Blob | null) => void> = [];
	const readies: Array<() => void> = [];
	let ready = false;

	const canvas = {
		toBlob(callback: (blob: Blob | null) => void) {
			callbacks.push(callback);
		},
	};

	class Mock {
		constructor(_element: unknown, options?: { ready?: () => void }) {
			if (options?.ready) readies.push(options.ready);
		}

		getCroppedCanvas() {
			return ready ? canvas : null;
		}

		destroy() {
			return undefined;
		}

		setAspectRatio() {
			return undefined;
		}

		crop() {
			return undefined;
		}

		setDragMode() {
			return undefined;
		}

		clear() {
			return undefined;
		}
	}

	function setCropperReady(value: boolean) {
		ready = value;
	}

	return { toBlobCallbacks: callbacks, readyCallbacks: readies, CropperMock: Mock, setCropperReady };
});

vi.mock('cropperjs', () => ({ default: CropperMock }));

const apiGet = vi.fn<(path: string, config?: unknown) => Promise<unknown>>();

const apiPatch = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(() =>
	Promise.resolve({ data: { data: { id: FILE_A } } })
);

vi.mock('@/api', () => ({
	default: {
		get: (path: string, config?: unknown) => apiGet(path, config),
		patch: (path: string, body?: unknown) => apiPatch(path, body),
	},
}));

import ImageEditor from './image-editor.vue';

enableAutoUnmount(afterEach);

const i18n = createI18n({ legacy: false });

const imageMeta = {
	type: 'image/png',
	filesize: 100,
	filename_download: 'photo.png',
	width: 10,
	height: 10,
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

// eslint-disable-next-line vue/one-component-per-file
const VButton = defineComponent({
	name: 'VButton',
	props: { disabled: { type: Boolean, default: false }, loading: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

const VDrawer = {
	template: '<div><slot name="actions" /><slot name="subtitle" /><slot /></div>',
};

const stubs = {
	'v-drawer': VDrawer,
	'v-button': VButton,
	'v-icon': { props: ['name'], template: '<i :data-name="name" />' },
	'v-notice': { template: '<div class="v-notice"><slot /></div>' },
	'v-progress-circular': { template: '<div class="v-progress-circular" />' },
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

async function mountEditor(
	options: {
		id?: string;
		admin?: boolean;
		permissions?: Permission[];
		capability?: ItemPermissions | null;
		capabilityDeferred?: ReturnType<typeof deferred<{ data: { data: ItemPermissions } }>>;
		capabilityError?: boolean;
		imagePending?: boolean;
		imageError?: boolean;
	} = {}
) {
	const id = options.id ?? FILE_A;

	apiGet.mockImplementation((path: string) => {
		if (path.startsWith('/permissions/me')) {
			if (options.capabilityDeferred) return options.capabilityDeferred.promise;
			if (options.capabilityError) return Promise.reject(new Error('capability failed'));
			return Promise.resolve({ data: { data: options.capability ?? null } });
		}

		if (options.imagePending) return new Promise(() => undefined);
		if (options.imageError) return Promise.reject(new Error('image failed'));
		return Promise.resolve({ data: { data: imageMeta } });
	});

	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { id: 'user-1', role: { id: 'role-1', admin_access: options.admin ?? false } };
	(usePermissionsStore() as any).permissions = options.permissions ?? [];

	const wrapper = mount(ImageEditor, {
		props: { id, modelValue: false },
		global: { plugins: [i18n, pinia], stubs, directives: { tooltip: {} } },
	});

	await wrapper.setProps({ modelValue: true });
	await flushPromises();

	return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountEditor>>;

function saveButton(wrapper: Wrapper) {
	return wrapper.findComponent(VButton);
}

function fireCropperReady() {
	setCropperReady(true);
	const callback = readyCallbacks[readyCallbacks.length - 1];
	if (callback) callback();
}

async function readyCropper(wrapper: Wrapper) {
	await flushPromises();
	await wrapper.find('img').trigger('load');
	await flushPromises();
	fireCropperReady();
	await flushPromises();
}

function capabilityRequests() {
	return apiGet.mock.calls.filter(([path]) => path.startsWith('/permissions/me')).length;
}

function patchTargets() {
	return apiPatch.mock.calls.filter(([path]) => path.startsWith('/files/')).map(([path]) => path);
}

beforeEach(() => {
	toBlobCallbacks.length = 0;
	readyCallbacks.length = 0;
	setCropperReady(false);
	apiGet.mockReset();
	apiPatch.mockClear();
});

describe('image-editor replacement gating', () => {
	it('lets an admin save without a capability request', async () => {
		const wrapper = await mountEditor({ admin: true });
		await readyCropper(wrapper);

		expect(capabilityRequests()).toBe(0);
		expect(saveButton(wrapper).props('disabled')).toBe(false);
	});

	it('lets an unconditional grant covering the replace fields save without a capability request', async () => {
		const wrapper = await mountEditor({ permissions: [perm(false, REPLACE_FIELDS)] });
		await readyCropper(wrapper);

		expect(capabilityRequests()).toBe(0);
		expect(saveButton(wrapper).props('disabled')).toBe(false);
	});

	it('disables save for a foreign file under a conditional grant', async () => {
		const wrapper = await mountEditor({ permissions: [perm(true, ['*'])], capability: cap(false, null) });
		await readyCropper(wrapper);

		expect(apiGet).toHaveBeenCalledWith(`/permissions/me/directus_files/${FILE_A}`, undefined);
		expect(saveButton(wrapper).props('disabled')).toBe(true);
	});

	it('saves an owned file whose conditional grant covers the replace fields', async () => {
		const wrapper = await mountEditor({ permissions: [perm(true, ['*'])], capability: cap(true, REPLACE_FIELDS) });
		await readyCropper(wrapper);

		expect(saveButton(wrapper).props('disabled')).toBe(false);

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();
		toBlobCallbacks.shift()!(new Blob(['x'], { type: 'image/png' }));
		await flushPromises();

		expect(patchTargets()).toEqual([`/files/${FILE_A}`]);
	});

	it('disables save when the conditional grant lacks a required replace field', async () => {
		const wrapper = await mountEditor({ permissions: [perm(true, ['*'])], capability: cap(true, ['title']) });
		await readyCropper(wrapper);

		expect(saveButton(wrapper).props('disabled')).toBe(true);
	});

	it('keeps save disabled until a conditional capability resolves', async () => {
		const pending = deferred<{ data: { data: ItemPermissions } }>();
		const wrapper = await mountEditor({ permissions: [perm(true, ['*'])], capabilityDeferred: pending });
		await readyCropper(wrapper);

		expect(saveButton(wrapper).props('disabled')).toBe(true);

		pending.resolve({ data: { data: cap(true, ['*']) } });
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(false);
	});

	it('keeps save disabled when the capability request fails', async () => {
		const wrapper = await mountEditor({ permissions: [perm(true, ['*'])], capabilityError: true });
		await readyCropper(wrapper);

		expect(saveButton(wrapper).props('disabled')).toBe(true);
	});

	it('keeps save disabled while the image data is still loading', async () => {
		const wrapper = await mountEditor({ admin: true, imagePending: true });
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(true);
	});

	it('keeps save disabled when the image data fails to load', async () => {
		const wrapper = await mountEditor({ admin: true, imageError: true });
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(true);
	});

	it('issues a single replacement for repeated save clicks', async () => {
		const wrapper = await mountEditor({ admin: true });
		await readyCropper(wrapper);

		saveButton(wrapper).vm.$emit('click');
		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(toBlobCallbacks).toHaveLength(1);

		toBlobCallbacks.shift()!(new Blob(['x'], { type: 'image/png' }));
		await flushPromises();

		expect(patchTargets()).toEqual([`/files/${FILE_A}`]);
	});

	it('never patches the new target when the file changes while a blob is pending', async () => {
		const wrapper = await mountEditor({ admin: true });
		await readyCropper(wrapper);

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		await wrapper.setProps({ id: FILE_B });
		await flushPromises();

		toBlobCallbacks.shift()!(new Blob(['x'], { type: 'image/png' }));
		await flushPromises();

		expect(patchTargets()).toEqual([]);
	});

	it('does not patch or refresh when the editor closes before the blob resolves', async () => {
		const wrapper = await mountEditor({ admin: true });
		await readyCropper(wrapper);

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		await wrapper.setProps({ modelValue: false });
		await flushPromises();

		toBlobCallbacks.shift()!(new Blob(['x'], { type: 'image/png' }));
		await flushPromises();

		expect(patchTargets()).toEqual([]);
		expect(wrapper.emitted('refresh')).toBeUndefined();
	});

	it('refetches the image when reopened', async () => {
		const wrapper = await mountEditor({ admin: true });
		await readyCropper(wrapper);

		const before = apiGet.mock.calls.filter(([path]) => path === `/files/${FILE_A}`).length;

		await wrapper.setProps({ modelValue: false });
		await flushPromises();
		await wrapper.setProps({ modelValue: true });
		await flushPromises();

		const after = apiGet.mock.calls.filter(([path]) => path === `/files/${FILE_A}`).length;
		expect(after).toBe(before + 1);
	});

	it('keeps save disabled until the cropper fires ready', async () => {
		const wrapper = await mountEditor({ admin: true });
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(true);

		await wrapper.find('img').trigger('load');
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(true);

		fireCropperReady();
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(false);
	});

	it('ignores a ready callback that fires after the target changed', async () => {
		const wrapper = await mountEditor({ admin: true });
		await flushPromises();

		await wrapper.find('img').trigger('load');
		await flushPromises();

		const staleReady = readyCallbacks[readyCallbacks.length - 1]!;

		await wrapper.setProps({ id: FILE_B });
		await flushPromises();

		setCropperReady(true);
		staleReady();
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(true);
	});

	it('does not refresh when a replacement completes after the editor closed', async () => {
		const patchPending = deferred<unknown>();
		apiPatch.mockImplementationOnce(() => patchPending.promise);

		const wrapper = await mountEditor({ admin: true });
		await readyCropper(wrapper);

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();
		toBlobCallbacks.shift()!(new Blob(['x'], { type: 'image/png' }));
		await flushPromises();

		expect(patchTargets()).toEqual([`/files/${FILE_A}`]);

		await wrapper.setProps({ modelValue: false });
		await flushPromises();

		patchPending.resolve({ data: { data: {} } });
		await flushPromises();

		expect(wrapper.emitted('refresh')).toBeUndefined();
	});

	it('does not let a superseded metadata response overwrite the current target', async () => {
		const fetchA = deferred<{ data: { data: typeof imageMeta } }>();
		const fetchB = deferred<{ data: { data: typeof imageMeta } }>();
		let imageCall = 0;

		apiGet.mockImplementation((path: string) => {
			if (path.startsWith('/permissions/me')) return Promise.resolve({ data: { data: null } });
			imageCall += 1;
			return imageCall === 1 ? fetchA.promise : fetchB.promise;
		});

		const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
		setActivePinia(pinia);
		(useUserStore() as any).currentUser = { id: 'user-1', role: { id: 'role-1', admin_access: true } };
		(usePermissionsStore() as any).permissions = [];

		const wrapper = mount(ImageEditor, {
			props: { id: FILE_A, modelValue: false },
			global: { plugins: [i18n, pinia], stubs, directives: { tooltip: {} } },
		});

		await wrapper.setProps({ modelValue: true });
		await flushPromises();

		await wrapper.setProps({ id: FILE_B });
		await flushPromises();

		fetchA.resolve({ data: { data: { ...imageMeta, filename_download: 'stale.png' } } });
		await flushPromises();

		expect(wrapper.find('.loader').exists()).toBe(true);
		expect(wrapper.find('img').exists()).toBe(false);

		fetchB.resolve({ data: { data: imageMeta } });
		await flushPromises();

		expect(wrapper.find('img').exists()).toBe(true);
	});
});
