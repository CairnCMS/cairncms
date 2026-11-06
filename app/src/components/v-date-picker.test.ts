import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import VDatePicker from './v-date-picker.vue';

vi.mock('@/utils/get-flatpickr-locale', () => ({ getFlatpickrLocale: () => ({}) }));

enableAutoUnmount(afterEach);

let container: HTMLElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	container.remove();
	vi.useRealTimers();
});

async function mountDatePicker(setToNowLabel: string) {
	const i18n = createI18n({
		legacy: false,
		locale: 'en-US',
		messages: { 'en-US': { interfaces: { datetime: { set_to_now: setToNowLabel } } } },
	});

	const wrapper = mount(VDatePicker, {
		props: { type: 'date' },
		global: { plugins: [i18n] },
		attachTo: container,
	});

	await flushPromises();

	const button = container.querySelector<HTMLButtonElement>('.set-to-now-button');

	return { wrapper, button };
}

test('renders the set to now label', async () => {
	const { button } = await mountDatePicker('Set to Now');

	expect(button?.textContent).toBe('Set to Now');
});

test('renders markup in the set to now label as text', async () => {
	const label = '<b class="injected">Now</b>';
	const { button } = await mountDatePicker(label);

	expect(button?.textContent).toBe(label);
	expect(container.querySelector('.injected')).toBeNull();
});

test('sets the value to now when the set to now button is clicked', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));

	const { wrapper, button } = await mountDatePicker('Set to Now');

	button?.click();

	expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['2026-01-02']);
});
