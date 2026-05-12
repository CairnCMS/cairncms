import { i18n } from '@/lang';
import { useServerStore } from '@/stores/server';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Navigation from './navigation.vue';

const stubs = {
	'v-list': { template: '<div><slot /></div>' },
	'v-list-item': {
		props: ['href', 'to'],
		template: '<a :href="href" :data-to="to" class="v-list-item-stub"><slot /></a>',
	},
	'v-list-item-icon': { template: '<span><slot /></span>' },
	'v-list-item-content': { template: '<span><slot /></span>' },
	'v-icon': { props: ['name'], template: '<i :data-name="name"></i>' },
	'v-text-overflow': { props: ['text'], template: '<span class="text">{{ text }}</span>' },
	'v-divider': { template: '<hr />' },
};

function mountNavigation() {
	return mount(Navigation, {
		global: {
			plugins: [i18n],
			stubs,
		},
	});
}

describe('Settings Navigation — version display', () => {
	beforeEach(() => {
		setActivePinia(
			createTestingPinia({
				createSpy: vi.fn,
				stubActions: true,
			})
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders the version row with the value from the server store when present', () => {
		const serverStore = useServerStore();
		serverStore.info.cairncms = { version: '9.9.9-test' };

		const wrapper = mountNavigation();

		expect(wrapper.html()).toContain('CairnCMS 9.9.9-test');
	});

	it('hides the version row when the server store has no version', () => {
		const serverStore = useServerStore();
		serverStore.info.cairncms = undefined;

		const wrapper = mountNavigation();

		expect(wrapper.html()).not.toContain('CairnCMS ');
		expect(wrapper.html()).not.toContain('github.com/CairnCMS/cairncms/releases');
	});
});
