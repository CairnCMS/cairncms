import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';

import VResizeable from './v-resizeable.vue';

class ImmediateIntersectionObserver {
	constructor(private callback: IntersectionObserverCallback) {}

	observe(target: Element) {
		this.callback(
			[{ isIntersecting: true, target, time: 1 } as IntersectionObserverEntry],
			this as unknown as IntersectionObserver
		);
	}

	unobserve() {
		return undefined;
	}

	disconnect() {
		return undefined;
	}
}

beforeEach(() => {
	vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver);

	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});

	vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function windowPointerMove(pageX: number) {
	const event = new Event('pointermove');
	Object.assign(event, { pageX });
	window.dispatchEvent(event);
}

function windowPointerUp() {
	window.dispatchEvent(new Event('pointerup'));
}

test('disabled renders the slot in a layout-neutral wrapper without a grab bar or width', async () => {
	const wrapper = mount(VResizeable, {
		props: { width: 300, disabled: true },
		slots: { default: '<div class="content" />' },
	});

	await nextTick();

	expect(wrapper.find('.content').exists()).toBe(true);
	expect(wrapper.find('.resize-wrapper').classes()).toContain('disabled');
	expect(wrapper.find('.grab-bar').exists()).toBe(false);
	expect((wrapper.find('.content').element as HTMLElement).style.width).toBe('');
});

test('toggling disabled keeps the same slot element mounted', async () => {
	const wrapper = mount(VResizeable, {
		props: { width: 300, disabled: true },
		slots: { default: '<div class="content" />' },
	});

	await nextTick();

	const element = wrapper.find('.content').element;

	await wrapper.setProps({ disabled: false });
	await nextTick();

	expect(wrapper.find('.content').element).toBe(element);
	expect((element as HTMLElement).style.width).toBe('300px');

	await wrapper.setProps({ disabled: true });
	await nextTick();

	expect(wrapper.find('.content').element).toBe(element);
	expect((element as HTMLElement).style.width).toBe('');
});

test('applies the width to the first slot element', async () => {
	const wrapper = mount(VResizeable, {
		props: { width: 300 },
		slots: { default: '<div class="content" />' },
	});

	await nextTick();

	expect((wrapper.find('.content').element as HTMLElement).style.width).toBe('300px');
});

test('caps the applied width at maxWidth', async () => {
	const wrapper = mount(VResizeable, {
		props: { width: 500, minWidth: 200, maxWidth: 400 },
		slots: { default: '<div class="content" />' },
	});

	await nextTick();

	expect((wrapper.find('.content').element as HTMLElement).style.width).toBe('400px');
});

test('double click emits the default width', async () => {
	const wrapper = mount(VResizeable, {
		props: { width: 500, minWidth: 200, defaultWidth: 250 },
		slots: { default: '<div class="content" />' },
	});

	await nextTick();
	await nextTick();

	await wrapper.find('.grab-bar').trigger('dblclick');

	expect(wrapper.emitted('update:width')?.at(-1)).toEqual([250]);
});

test('dragging emits dragging state and clamped widths', async () => {
	const wrapper = mount(VResizeable, {
		props: { width: 300, minWidth: 10, maxWidth: 400 },
		slots: { default: '<div class="content" />' },
	});

	await nextTick();
	await nextTick();

	await wrapper.find('.grab-bar').trigger('pointerdown', { pageX: 300 });

	expect(wrapper.emitted('dragging')?.at(-1)).toEqual([true]);

	windowPointerMove(350);

	expect(wrapper.emitted('update:width')?.at(-1)).toEqual([50]);

	windowPointerMove(900);

	expect(wrapper.emitted('update:width')?.at(-1)).toEqual([400]);

	windowPointerUp();
	await nextTick();

	expect(wrapper.emitted('dragging')?.at(-1)).toEqual([false]);
});

test('snaps to a zone when moving toward it', async () => {
	const wrapper = mount(VResizeable, {
		props: {
			width: 300,
			minWidth: 0,
			maxWidth: 400,
			options: { snapZones: [{ snapPos: 100, width: 60, direction: 'right' }] },
		},
		slots: { default: '<div class="content" />' },
	});

	await nextTick();
	await nextTick();

	await wrapper.find('.grab-bar').trigger('pointerdown', { pageX: 300 });

	windowPointerMove(360);

	expect(wrapper.emitted('update:width')?.at(-1)).toEqual([100]);

	windowPointerUp();
});

test('snap zone invokes onSnap', async () => {
	const onSnap = vi.fn();

	const wrapper = mount(VResizeable, {
		props: {
			width: 300,
			minWidth: 0,
			maxWidth: 400,
			options: { snapZones: [{ snapPos: 100, width: 60, direction: 'right', onSnap }] },
		},
		slots: { default: '<div class="content" />' },
	});

	await nextTick();
	await nextTick();

	await wrapper.find('.grab-bar').trigger('pointerdown', { pageX: 300 });

	windowPointerMove(360);

	expect(onSnap).toHaveBeenCalled();

	windowPointerUp();
});
