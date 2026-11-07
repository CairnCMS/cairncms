import { i18n } from '@/lang';
import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InputRichTextHtml from './input-rich-text-html.vue';

enableAutoUnmount(afterEach);

vi.mock('@tinymce/tinymce-vue', () => ({
	default: {
		name: 'EditorStub',
		props: ['modelValue', 'init', 'licenseKey', 'readonly', 'disabled', 'modelEvents'],
		template: '<div class="editor-stub" />',
	},
}));

vi.mock('tinymce/tinymce', () => ({}));
vi.mock('tinymce/icons/default', () => ({}));
vi.mock('tinymce/models/dom', () => ({}));
vi.mock('tinymce/plugins/autoresize/plugin', () => ({}));
vi.mock('tinymce/plugins/code/plugin', () => ({}));
vi.mock('tinymce/plugins/directionality/plugin', () => ({}));
vi.mock('tinymce/plugins/fullscreen/plugin', () => ({}));
vi.mock('tinymce/plugins/image/plugin', () => ({}));
vi.mock('tinymce/plugins/insertdatetime/plugin', () => ({}));
vi.mock('tinymce/plugins/link/plugin', () => ({}));
vi.mock('tinymce/plugins/lists/plugin', () => ({}));
vi.mock('tinymce/plugins/media/plugin', () => ({}));
vi.mock('tinymce/plugins/pagebreak/plugin', () => ({}));
vi.mock('tinymce/plugins/preview/plugin', () => ({}));
vi.mock('tinymce/plugins/table/plugin', () => ({}));
vi.mock('tinymce/themes/silver', () => ({}));

const stubs = Object.fromEntries(
	[
		'v-dialog',
		'v-card',
		'v-card-title',
		'v-card-text',
		'v-card-actions',
		'v-input',
		'v-checkbox',
		'v-button',
		'v-icon',
		'v-drawer',
		'v-upload',
		'v-select',
		'v-tabs',
		'v-tab',
		'v-tabs-items',
		'v-tab-item',
		'v-textarea',
		'interface-input-code',
	].map((name) => [name, true])
);

function mountEditor(props: Record<string, unknown>) {
	const pinia = createTestingPinia({ createSpy: vi.fn });
	setActivePinia(pinia);

	const wrapper = mount(InputRichTextHtml, {
		props: { value: '<p>Hello</p>', field: 'body', ...props },
		global: { plugins: [i18n, pinia], stubs, directives: { tooltip: {} } },
	});

	return wrapper.findComponent({ name: 'EditorStub' });
}

describe('editor read-only binding', () => {
	it('passes a read-only field to the editor as readonly, not disabled', () => {
		const editor = mountEditor({ disabled: true });

		expect(editor.props('readonly')).toBe(true);
		expect(editor.props('disabled')).toBeUndefined();
	});

	it('keeps an editable field editable', () => {
		const editor = mountEditor({ disabled: false });

		expect(editor.props('readonly')).toBe(false);
		expect(editor.props('disabled')).toBeUndefined();
	});
});

describe('editor license key', () => {
	it('defaults to the gpl key', () => {
		expect(mountEditor({}).props('licenseKey')).toBe('gpl');
	});

	it('passes a string license_key override through', () => {
		expect(mountEditor({ tinymceOverrides: { license_key: 'T8LK:example' } }).props('licenseKey')).toBe('T8LK:example');
	});

	it('falls back to the gpl key for a non-string license_key override', () => {
		expect(mountEditor({ tinymceOverrides: { license_key: 42 } }).props('licenseKey')).toBe('gpl');
	});
});

describe('editor init options', () => {
	it('hides branding and the menubar and enables the media plugin', () => {
		const init = mountEditor({}).props('init');

		expect(init.branding).toBe(false);
		expect(init.menubar).toBe(false);
		expect(init.plugins).toContain('media');
	});
});
