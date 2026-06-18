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

describe('Settings Navigation - support links', () => {
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

	it('links to the generic issue and discussion pages without a preselected template or category', () => {
		const wrapper = mountNavigation();
		const hrefs = wrapper.findAll('a.v-list-item-stub').map((anchor) => anchor.attributes('href'));

		expect(hrefs).toContain('https://github.com/CairnCMS/cairncms/issues/new');
		expect(hrefs).toContain('https://github.com/CairnCMS/cairncms/discussions/new');
		expect(hrefs.some((href) => href?.includes('?template='))).toBe(false);
		expect(hrefs.some((href) => href?.includes('?category='))).toBe(false);
	});
});

describe('Settings Navigation - sections', () => {
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

	it('links to the Extensions view', () => {
		const wrapper = mountNavigation();
		const tos = wrapper.findAll('a.v-list-item-stub').map((anchor) => anchor.attributes('data-to'));

		expect(tos).toContain('/settings/extensions');
	});

	it('renders the brick icon for the Extensions entry', () => {
		const wrapper = mountNavigation();

		const extensionsItem = wrapper
			.findAll('a.v-list-item-stub')
			.find((anchor) => anchor.attributes('data-to') === '/settings/extensions');

		expect(extensionsItem).toBeDefined();
		expect(extensionsItem?.html()).toContain('data-name="brick"');
	});
});
