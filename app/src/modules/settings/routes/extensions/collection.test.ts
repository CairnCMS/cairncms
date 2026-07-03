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
	'extension-options': {
		name: 'extension-options',
		emits: ['open-settings'],
		template: '<i class="ctx-toggle" />',
	},
	'extension-settings-drawer': {
		name: 'extension-settings-drawer',
		props: ['modelValue', 'subject', 'settings'],
		template: '<div class="settings-drawer" />',
	},
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

const sandboxedBundle = {
	name: 'cairncms-extension-api-metric',
	type: 'bundle',
	local: false,
	version: '1.0.0',
	status: 'loaded',
	runtime: 'confined-server',
	entries: [{ name: 'api-metric-panel', type: 'panel' }],
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
		expect(summary).toContain('Normal');
		expect(summary).not.toContain('Failed');
	});

	it('marks failures with a danger dot, counts them, and groups typeless failures under Other', async () => {
		vi.mocked(api.get).mockResolvedValue({ data: { data: [loadedHook, failedEndpoint, syntheticFailure] } });

		const wrapper = mountCollection();
		await flushPromises();

		expect(wrapper.find('.summary').text()).toContain('Failed');
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

	it('marks only sandboxed rows with a Sandboxed chip', async () => {
		vi.mocked(api.get).mockResolvedValue({ data: { data: [sandboxedBundle, loadedHook, discoveredInterface] } });

		const wrapper = mountCollection();
		await flushPromises();

		const sandboxedRow = rowFor(wrapper, 'cairncms-extension-api-metric')!;
		expect(sandboxedRow.find('.sandboxed').exists()).toBe(true);
		expect(sandboxedRow.find('.sandboxed').text()).toBe('Sandboxed');

		expect(rowFor(wrapper, 'cairn-fixture-hook')!.find('.sandboxed').exists()).toBe(false);
		expect(rowFor(wrapper, 'cairn-fixture-interface')!.find('.sandboxed').exists()).toBe(false);
	});

	it('marks settings-unavailable owners with a warning health dot and maps the reason in the modal', async () => {
		const collided = {
			name: 'cairncms-extension-edge-sync',
			type: 'hook',
			local: true,
			status: 'loaded',
			settings: {
				status: 'unavailable',
				reason: {
					code: 'settings-subject-config-collision',
					detail:
						'the settings subject "cairncms-extension-edge-sync" derives a config-secret variable that collides with "cairncms-extension-edge.sync"',
				},
			},
		};

		const healthy = { ...loadedHook, settings: { status: 'available' } };

		vi.mocked(api.get).mockResolvedValue({ data: { data: [collided, healthy, discoveredInterface] } });

		const wrapper = mountCollection();
		await flushPromises();

		const collidedRow = rowFor(wrapper, 'cairncms-extension-edge-sync')!;
		expect(collidedRow.find('.dot').attributes('data-color')).toBe('var(--warning)');
		expect(rowFor(wrapper, 'cairn-fixture-hook')!.find('.dot').attributes('data-color')).toBe('var(--success)');

		const summary = wrapper.find('.summary').text();
		expect(summary).toContain('Warning');
		expect(summary).toContain('1');

		await collidedRow.trigger('click');
		await nextTick();

		const notice = wrapper.find('.v-dialog .v-notice[data-type="warning"]');
		expect(notice.exists()).toBe(true);
		expect(notice.text()).toContain("Its configuration variables collide with another installed extension's");
		expect(notice.find('code.diagnostic-detail').text()).toContain('cairncms-extension-edge.sync');

		expect(wrapper.find('.v-dialog .detail-meta').text()).toContain('Warning');
		expect(wrapper.find('.v-dialog .v-notice[data-type="success"]').exists()).toBe(false);
		expect(wrapper.find('.v-dialog').text()).not.toContain('Loaded and running on the server');

		expect(wrapper.html()).not.toContain('CAIRNCMS_EXT_');
	});

	it('renders the settings menu only on settings-owning rows and opens the drawer', async () => {
		const owner = { ...loadedHook, settings: { status: 'available' } };

		vi.mocked(api.get).mockResolvedValue({ data: { data: [owner, discoveredInterface] } });

		const wrapper = mountCollection();
		await flushPromises();

		const ownerRow = rowFor(wrapper, 'cairn-fixture-hook')!;
		expect(ownerRow.find('.ctx-toggle').exists()).toBe(true);
		expect(rowFor(wrapper, 'cairn-fixture-interface')!.find('.ctx-toggle').exists()).toBe(false);

		expect(wrapper.findComponent({ name: 'extension-settings-drawer' }).exists()).toBe(false);

		ownerRow.findComponent({ name: 'extension-options' }).vm.$emit('open-settings');
		await nextTick();

		const drawer = wrapper.findComponent({ name: 'extension-settings-drawer' });
		expect(drawer.exists()).toBe(true);
		expect(drawer.props('subject')).toBe('cairn-fixture-hook');
	});

	it('renders the OS hardening posture inside the advanced diagnostics section', async () => {
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

		const section = wrapper.find('.advanced-diagnostics');
		expect(section.exists()).toBe(true);
		expect(section.text()).toContain('Advanced Diagnostics');
		expect(section.text()).toContain('network-namespace');
		expect(section.text()).toContain('cgroup-memory');

		// The posture is not a top-level notice.
		expect(wrapper.find('.sandbox-warning').exists()).toBe(false);
	});

	it('shows neither the warning nor the advanced diagnostics when not required', async () => {
		vi.mocked(api.get).mockResolvedValue({
			data: { data: [loadedHook], meta: { confinedRuntime: { state: 'not-required', posture: null } } },
		});

		const wrapper = mountCollection();
		await flushPromises();

		expect(wrapper.find('.sandbox-warning').exists()).toBe(false);
		expect(wrapper.find('.advanced-diagnostics').exists()).toBe(false);
	});

	it('shows the unavailable warning at the top, not in the advanced diagnostics', async () => {
		vi.mocked(api.get).mockResolvedValue({
			data: { data: [loadedHook], meta: { confinedRuntime: { state: 'unavailable', posture: null } } },
		});

		const wrapper = mountCollection();
		await flushPromises();

		const notice = wrapper.find('.sandbox-warning');
		expect(notice.exists()).toBe(true);
		expect(notice.text()).toContain('did not resolve');

		// Posture is absent when unavailable, so there is no advanced diagnostics section.
		expect(wrapper.find('.advanced-diagnostics').exists()).toBe(false);
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
			expect(notice.text()).toContain('reports discovery rather than a load');
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

		it('states the runtime as sandboxed, full authority, or browser app per extension', async () => {
			vi.mocked(api.get).mockResolvedValue({ data: { data: [sandboxedBundle, loadedHook, discoveredInterface] } });

			const wrapper = mountCollection();
			await flushPromises();

			await rowFor(wrapper, 'cairncms-extension-api-metric')!.trigger('click');
			await nextTick();
			expect(wrapper.find('.v-dialog .detail-runtime').text()).toContain('Sandboxed');

			await rowFor(wrapper, 'cairn-fixture-hook')!.trigger('click');
			await nextTick();
			expect(wrapper.find('.v-dialog .detail-runtime').text()).toContain('Full Authority');

			await rowFor(wrapper, 'cairn-fixture-interface')!.trigger('click');
			await nextTick();
			const browserRuntime = wrapper.find('.v-dialog .detail-runtime').text();
			expect(browserRuntime).toContain('Browser App');
			expect(browserRuntime).not.toContain('Full Authority');
		});

		it('omits the runtime line for a synthetic row that is not an extension', async () => {
			vi.mocked(api.get).mockResolvedValue({ data: { data: [syntheticFailure] } });

			const wrapper = mountCollection();
			await flushPromises();
			await rowFor(wrapper, '(extension discovery)')!.trigger('click');
			await nextTick();

			expect(wrapper.find('.v-dialog').exists()).toBe(true);
			expect(wrapper.find('.v-dialog .detail-runtime').exists()).toBe(false);
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
