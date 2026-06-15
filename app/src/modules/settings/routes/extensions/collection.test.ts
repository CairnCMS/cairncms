import api from '@/api';
import { i18n } from '@/lang';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import Collection from './collection.vue';

vi.mock('@/api', () => ({ default: { get: vi.fn() } }));
vi.mock('@/utils/unexpected-error', () => ({ unexpectedError: vi.fn() }));

vi.mock('@/displays/color/color.vue', () => ({
	default: { props: ['value'], template: '<span class="dot" :data-color="value"></span>' },
}));

const stubs = {
	'private-view': { template: '<div><slot /></div>' },
	'settings-navigation': { template: '<nav />' },
	'sidebar-detail': { template: '<aside><slot /></aside>' },
	'v-breadcrumb': { template: '<nav />' },
	'v-button': { emits: ['click'], template: '<button @click="$emit(\'click\')"><slot /></button>' },
	'v-icon': { props: ['name'], template: '<i :data-name="name"></i>' },
	'v-progress-circular': { template: '<div class="v-progress-circular" />' },
	'v-notice': { props: ['type'], template: '<div class="v-notice" :data-type="type"><slot /></div>' },
	'v-info': { props: ['title', 'icon'], template: '<div class="v-info"><slot /></div>' },
	'v-detail': {
		template: '<div class="v-detail"><slot name="activator" :toggle="() => {}" :active="true" /><slot /></div>',
	},
	'v-divider': { template: '<div class="v-divider"><slot name="icon" /><slot /></div>' },
	'v-list-item': { emits: ['click'], template: '<div class="v-list-item" @click="$emit(\'click\')"><slot /></div>' },
	'v-list-item-icon': { template: '<span><slot /></span>' },
	'v-list-item-content': { template: '<span><slot /></span>' },
	'v-chip': { template: '<span class="v-chip"><slot /></span>' },
	'v-text-overflow': { props: ['text'], template: '<span class="text-overflow">{{ text }}</span>' },
	'v-dialog': { props: ['modelValue'], template: '<div v-if="modelValue" class="v-dialog"><slot /></div>' },
	'v-card': { template: '<div class="v-card"><slot /></div>' },
	'v-card-title': { template: '<div class="v-card-title"><slot /></div>' },
	'v-card-text': { template: '<div class="v-card-text"><slot /></div>' },
	'v-card-actions': { template: '<div class="v-card-actions"><slot /></div>' },
};

const directives = {
	md: {},
};

function mountCollection() {
	return mount(Collection, {
		global: {
			plugins: [i18n],
			stubs,
			directives,
		},
	});
}

const loadedHook = { name: 'cairn-fixture-hook', type: 'hook', local: true, status: 'loaded' };

const discoveredInterface = { name: 'cairn-fixture-interface', type: 'interface', local: true, status: 'discovered' };

const bundle = {
	name: 'cairncms-extension-fixture-bundle',
	type: 'bundle',
	local: false,
	version: '1.0.0',
	status: 'loaded',
	entries: [
		{ name: 'cairn-bundle-interface', type: 'interface' },
		{ name: 'cairn-bundle-endpoint', type: 'endpoint' },
	],
};

const failedEndpoint = {
	name: 'cairn-broken-endpoint',
	type: 'endpoint',
	local: true,
	status: 'failed',
	reason: { code: 'REGISTRATION_FAILED', detail: 'boom' },
};

const syntheticFailure = {
	name: '(extension discovery)',
	type: null,
	local: true,
	status: 'failed',
	reason: { code: 'DISCOVERY_FAILED', detail: 'permission denied' },
};

function rowFor(wrapper: ReturnType<typeof mountCollection>, name: string) {
	return wrapper.findAll('.v-list-item').find((row) => row.text().includes(name));
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('Settings Extensions collection', () => {
	it('shows a spinner while the request is in flight', () => {
		vi.mocked(api.get).mockReturnValue(new Promise(() => undefined));

		const wrapper = mountCollection();

		expect(wrapper.find('.loading').exists()).toBe(true);
		expect(wrapper.find('.v-info').exists()).toBe(false);
		expect(wrapper.find('.group').exists()).toBe(false);
	});

	it('shows the empty state when no extensions are discovered', async () => {
		vi.mocked(api.get).mockResolvedValue({ data: { data: [] } });

		const wrapper = mountCollection();
		await flushPromises();

		expect(wrapper.find('.loading').exists()).toBe(false);
		expect(wrapper.find('.v-info').exists()).toBe(true);
		expect(wrapper.find('.group').exists()).toBe(false);
		expect(wrapper.find('.summary').exists()).toBe(false);
	});

	it('shows a generic translated notice and never raw error text when the fetch fails', async () => {
		vi.mocked(api.get).mockRejectedValue(new Error('Request failed with status code 500 at https://internal.example'));

		const wrapper = mountCollection();
		await flushPromises();

		const notice = wrapper.find('.v-notice[data-type="danger"]');
		expect(notice.exists()).toBe(true);
		expect(notice.text()).toContain('Could not load the extensions inventory.');

		const html = wrapper.html();
		expect(html).not.toContain('status code 500');
		expect(html).not.toContain('internal.example');
		expect(wrapper.find('.group').exists()).toBe(false);
	});

	it('groups active extensions by type with an icon, a status dot, and the version', async () => {
		vi.mocked(api.get).mockResolvedValue({ data: { data: [loadedHook, bundle, discoveredInterface] } });

		const wrapper = mountCollection();
		await flushPromises();

		expect(wrapper.findAll('.group')).toHaveLength(3);

		const labels = wrapper.findAll('.group-name').map((node) => node.text());
		expect(labels).toEqual(expect.arrayContaining(['Hooks', 'Bundles', 'Interfaces']));

		const html = wrapper.html();
		expect(html).toContain('data-name="webhook"');
		expect(html).toContain('data-name="deployed_code"');
		expect(html).toContain('data-name="tune"');

		expect(wrapper.findAll('.v-list-item .dot[data-color="var(--success)"]')).toHaveLength(3);
		expect(wrapper.find('.v-list-item .dot[data-color="var(--danger)"]').exists()).toBe(false);

		expect(wrapper.find('.v-list-item .version').text()).toBe('1.0.0');

		const summary = wrapper.find('.summary').text();
		expect(summary).toContain('3');
		expect(summary).toContain('active');
		expect(summary).not.toContain('failed');
	});

	it('marks failures with a danger dot, counts them, and groups typeless failures under Other', async () => {
		vi.mocked(api.get).mockResolvedValue({ data: { data: [loadedHook, failedEndpoint, syntheticFailure] } });

		const wrapper = mountCollection();
		await flushPromises();

		expect(wrapper.find('.summary').text()).toContain('failed');
		expect(wrapper.findAll('.v-list-item .dot[data-color="var(--danger)"]')).toHaveLength(2);

		const labels = wrapper.findAll('.group-name').map((node) => node.text());
		expect(labels).toEqual(expect.arrayContaining(['Hooks', 'Endpoints', 'Other']));
	});

	it('renders distinct rows for duplicate extension names', async () => {
		const first = { name: 'shared-name', type: 'hook', local: true, status: 'loaded' };
		const second = { name: 'shared-name', type: 'hook', local: false, status: 'loaded' };

		vi.mocked(api.get).mockResolvedValue({ data: { data: [first, second] } });

		const wrapper = mountCollection();
		await flushPromises();

		expect(wrapper.findAll('.v-list-item')).toHaveLength(2);
	});

	it('renders the confined runtime posture when available', async () => {
		vi.mocked(api.get).mockResolvedValue({
			data: {
				data: [loadedHook],
				meta: {
					confinedRuntime: {
						state: 'available',
						posture: {
							mode: 'auto',
							decision: 'run',
							applied: ['network-namespace'],
							missing: ['cgroup-memory'],
							cgroupMechanic: null,
						},
					},
				},
			},
		});

		const wrapper = mountCollection();
		await flushPromises();

		const panel = wrapper.find('.confined-runtime');
		expect(panel.exists()).toBe(true);
		expect(panel.text()).toContain('network-namespace');
		expect(panel.text()).toContain('cgroup-memory');
	});

	it('hides the confined runtime panel when not required', async () => {
		vi.mocked(api.get).mockResolvedValue({
			data: { data: [loadedHook], meta: { confinedRuntime: { state: 'not-required', posture: null } } },
		});

		const wrapper = mountCollection();
		await flushPromises();

		expect(wrapper.find('.confined-runtime').exists()).toBe(false);
	});

	it('renders a warning when the confined runtime is unavailable', async () => {
		vi.mocked(api.get).mockResolvedValue({
			data: { data: [loadedHook], meta: { confinedRuntime: { state: 'unavailable', posture: null } } },
		});

		const wrapper = mountCollection();
		await flushPromises();

		const panel = wrapper.find('.confined-runtime');
		expect(panel.exists()).toBe(true);

		const notice = panel.find('.v-notice[data-type="warning"]');
		expect(notice.exists()).toBe(true);
		expect(notice.text()).toContain('did not resolve');
	});

	describe('detail modal', () => {
		it('is closed until a row is clicked', async () => {
			vi.mocked(api.get).mockResolvedValue({ data: { data: [loadedHook] } });

			const wrapper = mountCollection();
			await flushPromises();

			expect(wrapper.find('.v-dialog').exists()).toBe(false);

			await rowFor(wrapper, 'cairn-fixture-hook')!.trigger('click');
			await nextTick();

			const dialog = wrapper.find('.v-dialog');
			expect(dialog.exists()).toBe(true);
			expect(dialog.find('.v-card-title').text()).toBe('cairn-fixture-hook');
		});

		it('shows the green loaded notice for a server extension', async () => {
			vi.mocked(api.get).mockResolvedValue({ data: { data: [loadedHook] } });

			const wrapper = mountCollection();
			await flushPromises();
			await rowFor(wrapper, 'cairn-fixture-hook')!.trigger('click');
			await nextTick();

			const notice = wrapper.find('.v-dialog .v-notice[data-type="success"]');
			expect(notice.exists()).toBe(true);
			expect(notice.text()).toContain('Loaded and running on the server');
		});

		it('shows the green discovered notice for an app extension', async () => {
			vi.mocked(api.get).mockResolvedValue({ data: { data: [discoveredInterface] } });

			const wrapper = mountCollection();
			await flushPromises();
			await rowFor(wrapper, 'cairn-fixture-interface')!.trigger('click');
			await nextTick();

			const notice = wrapper.find('.v-dialog .v-notice[data-type="success"]');
			expect(notice.text()).toContain('runs in the browser');
		});

		it('shows the failure reason in a danger notice for a failed extension', async () => {
			vi.mocked(api.get).mockResolvedValue({ data: { data: [failedEndpoint] } });

			const wrapper = mountCollection();
			await flushPromises();
			await rowFor(wrapper, 'cairn-broken-endpoint')!.trigger('click');
			await nextTick();

			const notice = wrapper.find('.v-dialog .v-notice[data-type="danger"]');
			expect(notice.exists()).toBe(true);
			expect(notice.text()).toContain('REGISTRATION_FAILED: boom');
		});

		it('lists the nested extensions for a bundle', async () => {
			vi.mocked(api.get).mockResolvedValue({ data: { data: [bundle] } });

			const wrapper = mountCollection();
			await flushPromises();
			await rowFor(wrapper, 'cairncms-extension-fixture-bundle')!.trigger('click');
			await nextTick();

			const entries = wrapper.find('.v-dialog .detail-entries');
			expect(entries.exists()).toBe(true);
			expect(entries.text()).toContain('cairn-bundle-interface');
			expect(entries.text()).toContain('cairn-bundle-endpoint');
		});

		it('renders declared capabilities and defaults an omitted request method to GET', async () => {
			const capable = {
				name: 'cairn-capable-op',
				type: 'operation',
				local: true,
				status: 'loaded',
				capabilities: { log: true, request: { urls: ['https://api.example.com'] } },
			};

			vi.mocked(api.get).mockResolvedValue({ data: { data: [capable] } });

			const wrapper = mountCollection();
			await flushPromises();
			await rowFor(wrapper, 'cairn-capable-op')!.trigger('click');
			await nextTick();

			const caps = wrapper.find('.v-dialog .detail-capabilities');
			expect(caps.exists()).toBe(true);
			expect(caps.text()).toContain('log');
			// An omitted request method defaults to GET, matching the broker allowlist.
			expect(caps.text()).toContain('GET');
			expect(caps.text()).toContain('https://api.example.com');
		});
	});
});
