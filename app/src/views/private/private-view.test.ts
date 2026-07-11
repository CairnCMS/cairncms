import { createTestingPinia } from '@pinia/testing';
import { config, mount } from '@vue/test-utils';
import { GlobalMountOptions } from '@vue/test-utils/dist/types';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import { nextTick } from 'vue';

import VResizeable from '@/components/v-resizeable.vue';
import PrivateView from './private-view.vue';

vi.mock('vue-router', async (importOriginal) => {
	const actual = await importOriginal<typeof import('vue-router')>();
	return { ...actual, useRouter: () => ({ afterEach: vi.fn() }) };
});

const i18n = createI18n({ legacy: false });

vi.spyOn(i18n.global, 't').mockImplementation((key: any) => key);

const global: GlobalMountOptions = {
	plugins: [i18n],
	stubs: ['v-button', 'v-info', 'v-nav', 'v-overlay'],
};

function setWindowWidth(width: number) {
	Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}

beforeEach(() => {
	localStorage.clear();
	config.global.renderStubDefaultSlot = true;

	setActivePinia(
		createTestingPinia({
			createSpy: vi.fn,
			stubActions: false,
		})
	);

	setWindowWidth(1920);
});

afterEach(() => {
	config.global.renderStubDefaultSlot = false;
});

test('renders no split content by default', () => {
	const wrapper = mount(PrivateView, { global, shallow: true });

	expect(wrapper.find('#split-content').exists()).toBe(false);
	expect(wrapper.find('main').exists()).toBe(true);
	expect(wrapper.classes()).not.toContain('split-view');
});

test('renders the splitView slot into the split region', () => {
	const wrapper = mount(PrivateView, {
		props: { splitView: true, splitViewMinWidth: 310 },
		slots: { splitView: '<div id="pane">pane</div>' },
		global,
		shallow: true,
	});

	expect(wrapper.classes()).toContain('split-view');
	expect(wrapper.find('#split-content').exists()).toBe(true);
	expect(wrapper.find('#split-content #pane').text()).toBe('pane');

	const main = wrapper.find('main').element as HTMLElement;
	expect(main.style.display).not.toBe('none');
});

test('hides main when the window cannot fit the split minimum', () => {
	setWindowWidth(800);

	const wrapper = mount(PrivateView, {
		props: { splitView: true, splitViewMinWidth: 310 },
		global,
		shallow: true,
	});

	const main = wrapper.find('main').element as HTMLElement;
	expect(main.style.display).toBe('none');
});

test('opening the split view carries the scroll position into the main pane', async () => {
	const wrapper = mount(PrivateView, { global, shallow: true });

	const content = wrapper.find('#main-content').element as HTMLElement;
	content.scrollTop = 250;

	await wrapper.setProps({ splitView: true });
	await nextTick();

	const main = wrapper.find('main').element as HTMLElement;
	expect(main.scrollTop).toBe(250);
});

test('closing the split view carries the scroll position back to the content', async () => {
	const wrapper = mount(PrivateView, {
		props: { splitView: true },
		global,
		shallow: true,
	});

	const main = wrapper.find('main').element as HTMLElement;
	main.scrollTop = 400;

	await wrapper.setProps({ splitView: false });
	await nextTick();

	const content = wrapper.find('#main-content').element as HTMLElement;
	expect(content.scrollTop).toBe(400);
});

test('a rapid toggle sequence preserves the scroll position end to end', async () => {
	const wrapper = mount(PrivateView, { global, shallow: true });

	const content = wrapper.find('#main-content').element as HTMLElement;
	content.scrollTop = 250;

	await wrapper.setProps({ splitView: true });
	await nextTick();

	await wrapper.setProps({ splitView: false });
	await nextTick();

	expect(content.scrollTop).toBe(250);
});

test('toggling never touches the content inline overflow styles', async () => {
	const wrapper = mount(PrivateView, { global, shallow: true });

	const content = wrapper.find('#main-content').element as HTMLElement;

	await wrapper.setProps({ splitView: true });
	await nextTick();

	expect(content.style.overflowX).toBe('');
	expect(content.style.overflowY).toBe('');

	await wrapper.setProps({ splitView: false });
	await nextTick();

	expect(content.style.overflowX).toBe('');
	expect(content.style.overflowY).toBe('');
});

test('falls back to the minimum width when stored main width is not numeric', () => {
	localStorage.setItem('directus-main-content-width', JSON.stringify('abc'));

	const wrapper = mount(PrivateView, {
		props: { splitView: true, splitViewMinWidth: 310 },
		global,
		shallow: true,
	});

	expect(wrapper.findComponent(VResizeable).props('width')).toBe(590);
});
