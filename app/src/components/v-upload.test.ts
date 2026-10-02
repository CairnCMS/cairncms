import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';

const FILE_ID = '11111111-1111-4111-8111-111111111111';

const apiPost = vi.fn();
const apiGet = vi.fn();

vi.mock('@/api', () => ({
	default: {
		post: (...args: unknown[]) => apiPost(...args),
		get: (...args: unknown[]) => apiGet(...args),
	},
}));

vi.mock('@/events', () => ({ default: { emit: vi.fn() }, Events: { upload: 'upload' } }));
vi.mock('@/utils/unexpected-error', () => ({ unexpectedError: vi.fn() }));
vi.mock('@/utils/upload-file', () => ({ uploadFile: vi.fn() }));
vi.mock('@/utils/upload-files', () => ({ uploadFiles: vi.fn() }));

vi.mock('@/views/private/components/drawer-files.vue', () => ({
	default: { name: 'DrawerFiles', template: '<div />' },
}));

import VUpload from './v-upload.vue';

enableAutoUnmount(afterEach);

const i18n = createI18n({ legacy: false });

const stubs = {
	'v-icon': { template: '<i />' },
	'v-button': {
		inheritAttrs: false,
		emits: ['click'],
		template: '<button @click="$emit(\'click\')"><slot /></button>',
	},
	'v-progress-linear': { template: '<div />' },
	'v-dialog': { template: '<div><slot /></div>' },
	'v-card': { template: '<div><slot /></div>' },
	'v-card-title': { template: '<div><slot /></div>' },
	'v-card-text': { template: '<div><slot /></div>' },
	'v-card-actions': { template: '<div><slot /></div>' },
	'v-input': {
		props: ['modelValue'],
		emits: ['update:modelValue'],
		template:
			'<input class="url-input" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
	},
};

function mountUpload() {
	return mount(VUpload, {
		props: { fileId: FILE_ID, fromUrl: true },
		global: { plugins: [i18n], stubs, directives: { tooltip: {} } },
	});
}

async function importUrl(wrapper: ReturnType<typeof mountUpload>, url: string) {
	await wrapper.find('input.url-input').setValue(url);

	const importButton = wrapper.findAll('button').find((button) => button.text() === 'import_label');
	await importButton!.trigger('click');
	await flushPromises();
}

beforeEach(() => {
	apiPost.mockReset();
	apiGet.mockReset();
});

describe('v-upload URL replacement', () => {
	it('sends the target id and reports the record on a 200', async () => {
		apiPost.mockResolvedValue({ status: 200, data: { data: { id: FILE_ID, title: 'kept' } } });

		const wrapper = mountUpload();
		await importUrl(wrapper, 'https://example.com/a.png');

		expect(apiPost).toHaveBeenCalledWith('/files/import', {
			url: 'https://example.com/a.png',
			data: { folder: undefined, id: FILE_ID },
		});

		expect(wrapper.emitted('input')?.[0]).toEqual([{ id: FILE_ID, title: 'kept' }]);
	});

	it('reports the target id on a 204 replace without read permission', async () => {
		apiPost.mockResolvedValue({ status: 204, data: '' });

		const wrapper = mountUpload();
		await importUrl(wrapper, 'https://example.com/a.png');

		expect(wrapper.emitted('input')?.[0]).toEqual([{ id: FILE_ID }]);
	});
});
