import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import type { ItemPermissions, Panel, Permission, PermissionsAction, User } from '@cairncms/types';
import { useInsightsStore, type CreatePanel } from '@/stores/insights';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';

const PANEL_A = '11111111-1111-4111-8111-111111111111';
const PANEL_B = '22222222-2222-4222-8222-222222222222';
const DASH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DASH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const isOpen = ref(true);
vi.mock('@/composables/use-dialog-route', () => ({ useDialogRoute: () => isOpen }));

const apiGet = vi.fn<(path: string) => Promise<unknown>>(() => new Promise(() => undefined));

const apiPost = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(() =>
	Promise.resolve({ data: { data: [] } })
);

const apiPatch = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(() =>
	Promise.resolve({ data: { data: [] } })
);

const apiDelete = vi.fn<(path: string, config?: unknown) => Promise<unknown>>(() =>
	Promise.resolve({ data: { data: [] } })
);

vi.mock('@/api', () => ({
	default: {
		get: (path: string) => apiGet(path),
		post: (path: string, body?: unknown) => apiPost(path, body),
		patch: (path: string, body?: unknown) => apiPatch(path, body),
		delete: (path: string, config?: unknown) => apiDelete(path, config),
	},
}));

const routerPush = vi.fn();

vi.mock('vue-router', async (importOriginal) => ({
	...(await importOriginal<typeof import('vue-router')>()),
	useRouter: () => ({ push: routerPush }),
	onBeforeRouteLeave: vi.fn(),
}));

vi.mock('@/extensions', async () => {
	const { ref: r } = await import('vue');
	return {
		useExtensions: () => ({
			panels: r([{ id: 'metric', name: 'Metric', icon: 'functions', description: '', options: null }]),
		}),
	};
});

vi.mock('@/composables/use-extension', async () => {
	const { computed, unref } = await import('vue');

	const dimensions: Record<string, { minWidth: number; minHeight: number }> = {
		metric: { minWidth: 8, minHeight: 6 },
	};

	return {
		useExtension: (_type: unknown, id: unknown) =>
			computed(() => {
				const key = unref(id) as string | null;
				if (!key) return null;
				return { ...(dimensions[key] ?? { minWidth: 4, minHeight: 4 }), options: null };
			}),
	};
});

import PanelConfiguration from './panel-configuration.vue';

enableAutoUnmount(afterEach);

const i18n = createI18n({ legacy: false });

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
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

// eslint-disable-next-line vue/one-component-per-file
const Field = defineComponent({
	name: 'FieldStub',
	props: { disabled: { type: Boolean, default: false }, placeholder: { type: String, default: '' } },
	emits: ['update:modelValue', 'input'],
	template: '<div class="field-stub" :data-placeholder="placeholder" :data-disabled="disabled" />',
});

const VDrawer = { template: '<div><slot name="actions" /><slot /></div>' };

const stubs = {
	'v-drawer': VDrawer,
	'v-button': VButton,
	'v-icon': { props: ['name'], template: '<i :data-name="name" />' },
	'v-fancy-select': Field,
	'extension-options': Field,
	'v-checkbox': Field,
	'v-input': Field,
	'interface-select-icon': Field,
	'interface-select-color': Field,
	'v-divider': { template: '<hr />' },
};

function panelFixture(overrides: Partial<Panel> = {}): Panel {
	return {
		id: PANEL_A,
		dashboard: DASH_A,
		show_header: true,
		name: 'Existing panel',
		icon: 'functions',
		color: '#6644ff',
		note: '',
		type: 'metric',
		position_x: 1,
		position_y: 1,
		width: 8,
		height: 6,
		options: {},
		date_created: '2026-01-01T00:00:00Z',
		user_created: 'user-1',
		...overrides,
	};
}

function createPanelFixture(overrides: Partial<CreatePanel> = {}): CreatePanel {
	return {
		id: '_dup',
		dashboard: DASH_A,
		type: 'metric',
		options: {},
		width: 8,
		height: 6,
		position_x: 1,
		position_y: 1,
		show_header: true,
		name: 'Copy',
		...overrides,
	} as CreatePanel;
}

function perm(
	action: PermissionsAction,
	fields: string[] | null,
	conditional = false,
	presets: Record<string, any> | null = null
): Permission {
	return {
		role: 'role-1',
		collection: 'directus_panels',
		action,
		permissions: conditional ? { user_created: { _eq: '$CURRENT_USER' } } : {},
		fields,
		presets,
		validation: null,
	};
}

function makeUser(admin: boolean): User {
	return {
		id: 'user-1',
		status: 'active',
		first_name: 'Test',
		last_name: 'User',
		email: 'test@example.com',
		token: '',
		last_login: '',
		last_page: '',
		external_id: '',
		tfa_secret: '',
		theme: 'auto',
		role: {
			id: 'role-1',
			name: 'Role',
			key: 'role',
			description: '',
			icon: '',
			enforce_tfa: false,
			external_id: null,
			ip_whitelist: [],
			app_access: true,
			admin_access: admin,
		},
		password_reset_token: null,
		timezone: 'UTC',
		language: 'en-US',
		avatar: null,
		company: null,
		title: null,
		email_notifications: false,
	};
}

function setSavedPanels(store: ReturnType<typeof useInsightsStore>, panels: Panel[]) {
	// @ts-expect-error pinia testing exposes store getters as writable overrides
	store.panels = panels;
}

function itemCapability(update: { access: boolean; fields: string[] | null }): { data: { data: ItemPermissions } } {
	return { data: { data: { update, delete: { access: false }, share: { access: false } } } };
}

function mountEditor(
	panelKey: string,
	options: {
		permissions?: Permission[];
		admin?: boolean;
		panels?: Panel[];
		staged?: CreatePanel[];
		dashboardKey?: string;
		realStaging?: boolean;
	} = {}
) {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	const insights = useInsightsStore();
	if (options.panels !== undefined) setSavedPanels(insights, options.panels);
	for (const entry of options.staged ?? []) insights.edits.create.push(entry);

	if (options.realStaging !== true) {
		vi.spyOn(insights, 'stagePanelCreate').mockImplementation(() => undefined);
		vi.spyOn(insights, 'stagePanelUpdate').mockImplementation(() => undefined);
	}

	usePermissionsStore().permissions = options.permissions ?? [];
	useUserStore().currentUser = makeUser(options.admin ?? false);

	const wrapper = mount(PanelConfiguration, {
		props: { dashboardKey: options.dashboardKey ?? DASH_A, panelKey },
		global: { plugins: [i18n, pinia], stubs, directives: { tooltip: {} } },
	});

	return { wrapper, insights };
}

function doneButton(wrapper: ReturnType<typeof mountEditor>['wrapper']) {
	return wrapper.findAllComponents(VButton).find((button) => button.html().includes('data-name="check"'))!;
}

function typeSelect(wrapper: ReturnType<typeof mountEditor>['wrapper']) {
	return wrapper.findAllComponents(Field)[0]!;
}

function fieldByPlaceholder(wrapper: ReturnType<typeof mountEditor>['wrapper'], placeholder: string) {
	return wrapper.findAllComponents(Field).find((field) => field.props('placeholder') === placeholder)!;
}

beforeEach(() => {
	isOpen.value = true;
	apiGet.mockReset();
	apiGet.mockImplementation(() => new Promise(() => undefined));
	apiPost.mockClear();
	apiPatch.mockClear();
	apiDelete.mockClear();
	routerPush.mockClear();
});

describe('panel configuration permission gating', () => {
	it('does not fetch item permissions for an admin and leaves controls editable', async () => {
		const { wrapper } = mountEditor(PANEL_A, { admin: true, panels: [panelFixture()] });
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(doneButton(wrapper).props('disabled')).toBe(false);
		expect(fieldByPlaceholder(wrapper, 'panel_name_placeholder').props('disabled')).toBe(false);
	});

	it('does not fetch for an unconditional update and gates on the granted fields', async () => {
		const { wrapper } = mountEditor(PANEL_A, { permissions: [perm('update', ['name'])], panels: [panelFixture()] });
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(doneButton(wrapper).props('disabled')).toBe(false);
	});

	it('disables the editor for a foreign panel under a conditional grant', async () => {
		const capability = deferred<{ data: { data: ItemPermissions } }>();
		apiGet.mockReturnValue(capability.promise);

		const { wrapper, insights } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'], true)],
			panels: [panelFixture()],
		});

		await flushPromises();
		expect(apiGet).toHaveBeenCalledWith(`/permissions/me/directus_panels/${PANEL_A}`);
		expect(doneButton(wrapper).props('disabled')).toBe(true);

		capability.resolve(itemCapability({ access: false, fields: [] }));
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(true);

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();
		expect(insights.stagePanelUpdate).not.toHaveBeenCalled();
		expect(routerPush).not.toHaveBeenCalled();
	});

	it('stages only the writable content for an own panel under a conditional subset grant', async () => {
		const capability = deferred<{ data: { data: ItemPermissions } }>();
		apiGet.mockReturnValue(capability.promise);

		const { wrapper, insights } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'], true)],
			panels: [panelFixture()],
		});

		await flushPromises();

		capability.resolve(itemCapability({ access: true, fields: ['name'] }));
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(false);
		expect(fieldByPlaceholder(wrapper, 'panel_note_placeholder').props('disabled')).toBe(true);

		fieldByPlaceholder(wrapper, 'panel_name_placeholder').vm.$emit('update:modelValue', 'Renamed');
		await flushPromises();

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(insights.stagePanelUpdate).toHaveBeenCalledWith({ id: PANEL_A, edits: { name: 'Renamed' } });
	});

	it('keeps the editor unavailable when the capability fetch fails', async () => {
		const capability = deferred<{ data: { data: ItemPermissions } }>();
		apiGet.mockReturnValue(capability.promise);

		const { wrapper } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'], true)],
			panels: [panelFixture()],
		});

		await flushPromises();

		capability.reject(new Error('network'));
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(true);
	});

	it('does not treat an identity or layout only grant as editable content', async () => {
		const { wrapper } = mountEditor(PANEL_A, { permissions: [perm('update', ['width'])], panels: [panelFixture()] });
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(true);
	});

	it('requires an effective type value for a create even as an admin', async () => {
		const { wrapper } = mountEditor('+', { admin: true });
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(true);

		typeSelect(wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(false);
	});

	it('disables a create again when the chosen type is cleared', async () => {
		const { wrapper } = mountEditor('+', { admin: true });
		await flushPromises();

		typeSelect(wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(false);

		typeSelect(wrapper).vm.$emit('update:modelValue', null);
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(true);
	});

	it('does not restore a preset type when the selector is cleared in a create', async () => {
		const presets = { type: 'metric', dashboard: DASH_A, position_x: 1, position_y: 1, width: 8, height: 6 };

		const { wrapper } = mountEditor('+', { permissions: [perm('create', ['type', 'name'], false, presets)] });
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(false);

		typeSelect(wrapper).vm.$emit('update:modelValue', null);
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(true);

		typeSelect(wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(false);
	});

	it('does not restore a staged type when the selector is cleared on reopen', async () => {
		const { wrapper } = mountEditor('_dup', { admin: true, staged: [createPanelFixture({ id: '_dup' })] });
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(false);

		typeSelect(wrapper).vm.$emit('update:modelValue', null);
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(true);

		typeSelect(wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(false);
	});

	it('rejects a cleared required type in a persisted editor', async () => {
		const { wrapper, insights } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'])],
			panels: [panelFixture()],
		});

		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(false);

		typeSelect(wrapper).vm.$emit('update:modelValue', null);
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(true);

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();
		expect(insights.stagePanelUpdate).not.toHaveBeenCalled();
	});

	it('allows a name-only save after a refresh drops a cleared type from the writable fields', async () => {
		const responses: Array<ReturnType<typeof deferred<{ data: { data: ItemPermissions } }>>> = [];

		apiGet.mockImplementation((path: string) => {
			if (!path.includes('/permissions/me')) return Promise.resolve({ data: { data: [] } });
			const d = deferred<{ data: { data: ItemPermissions } }>();
			responses.push(d);
			return d.promise;
		});

		const { wrapper, insights } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'], true)],
			panels: [panelFixture()],
			realStaging: true,
		});

		await flushPromises();

		responses[0]!.resolve(itemCapability({ access: true, fields: ['type', 'name'] }));
		await flushPromises();

		typeSelect(wrapper).vm.$emit('update:modelValue', null);
		fieldByPlaceholder(wrapper, 'panel_name_placeholder').vm.$emit('update:modelValue', 'Renamed');
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(true);

		setSavedPanels(insights, [panelFixture({ name: 'Refreshed Stored' })]);
		await flushPromises();

		responses[1]!.resolve(itemCapability({ access: true, fields: ['name'] }));
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(false);

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		await insights.saveChanges();

		const patchBody = apiPatch.mock.calls.find(([path]) => path === '/panels')?.[1] as Record<string, unknown>[];
		expect(patchBody).toEqual([{ id: PANEL_A, name: 'Renamed' }]);
	});

	it('blocks a create whose presets do not cover the required columns', async () => {
		const { wrapper } = mountEditor('+', { permissions: [perm('create', [], false, { type: 'metric' })] });
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(true);
	});

	it('treats a null preset set as no presets for create validity', async () => {
		const denied = mountEditor('+', { permissions: [perm('create', [], false, null)] });
		await flushPromises();
		expect(doneButton(denied.wrapper).props('disabled')).toBe(true);

		const allowed = mountEditor('+', { permissions: [perm('create', ['*'], false, null)] });
		await flushPromises();
		expect(doneButton(allowed.wrapper).props('disabled')).toBe(true);

		typeSelect(allowed.wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();
		expect(doneButton(allowed.wrapper).props('disabled')).toBe(false);
	});

	it('allows a preset-only create whose presets cover every required column', async () => {
		const presets = {
			type: 'metric',
			dashboard: DASH_B,
			position_x: 1,
			position_y: 1,
			width: 4,
			height: 4,
		};

		const { wrapper, insights } = mountEditor('+', { permissions: [perm('create', [], false, presets)] });
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(false);

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(insights.stagePanelCreate).toHaveBeenCalled();
	});

	it('disables the editor when no fields are writable', async () => {
		const capability = deferred<{ data: { data: ItemPermissions } }>();
		apiGet.mockReturnValue(capability.promise);

		const { wrapper } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'], true)],
			panels: [panelFixture()],
		});

		await flushPromises();

		capability.resolve(itemCapability({ access: true, fields: [] }));
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(true);
	});

	it('gates the create route on the create permission', async () => {
		const denied = mountEditor('+', { permissions: [perm('update', ['*'])], panels: [] });
		await flushPromises();
		expect(doneButton(denied.wrapper).props('disabled')).toBe(true);

		const allowed = mountEditor('+', { permissions: [perm('create', ['*'])], panels: [] });
		await flushPromises();
		expect(doneButton(allowed.wrapper).props('disabled')).toBe(true);

		typeSelect(allowed.wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();
		expect(doneButton(allowed.wrapper).props('disabled')).toBe(false);

		doneButton(allowed.wrapper).vm.$emit('click');
		await flushPromises();
		expect(allowed.insights.stagePanelCreate).toHaveBeenCalled();
	});

	it('treats a re-opened staged panel as unavailable without a matching staged entry', async () => {
		const missing = mountEditor('_missing', { permissions: [perm('create', ['*'])], panels: [] });
		await flushPromises();
		expect(doneButton(missing.wrapper).props('disabled')).toBe(true);
	});

	it('does not stage when invoked while the editor is closed', async () => {
		const { wrapper, insights } = mountEditor(PANEL_A, { admin: true, panels: [panelFixture()] });
		await flushPromises();

		isOpen.value = false;
		await flushPromises();

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(insights.stagePanelUpdate).not.toHaveBeenCalled();
	});

	it('resets the draft when the target changes so it cannot be staged under the new panel', async () => {
		const { wrapper, insights } = mountEditor(PANEL_A, {
			admin: true,
			panels: [panelFixture(), panelFixture({ id: PANEL_B, name: 'Second' })],
		});

		await flushPromises();

		fieldByPlaceholder(wrapper, 'panel_name_placeholder').vm.$emit('update:modelValue', 'Draft edit');
		await flushPromises();

		await wrapper.setProps({ panelKey: PANEL_B });
		await flushPromises();

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(insights.stagePanelUpdate).not.toHaveBeenCalled();
	});

	it('stages a create with type-derived dimensions and the route dashboard, then POSTs it filtered', async () => {
		apiGet.mockImplementation(() => Promise.resolve({ data: { data: [] } }));

		const { wrapper, insights } = mountEditor('+', { admin: true, dashboardKey: DASH_A, realStaging: true });
		await flushPromises();

		typeSelect(wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		const staged = insights.edits.create[0]!;
		expect(staged).toMatchObject({ type: 'metric', dashboard: DASH_A, width: 8, height: 6, options: {} });

		await insights.saveChanges();

		expect(apiPost).toHaveBeenCalledWith('/panels', [
			{ type: 'metric', dashboard: DASH_A, width: 8, height: 6, position_x: 1, position_y: 1, options: {} },
		]);
	});

	it('keeps a reopened staged create editable so admins can restage it unchanged', async () => {
		apiGet.mockImplementation(() => Promise.resolve({ data: { data: [] } }));

		const { wrapper, insights } = mountEditor('+', { admin: true, dashboardKey: DASH_A, realStaging: true });
		await flushPromises();

		typeSelect(wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();
		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		const stagedId = insights.edits.create[0]!.id;

		await wrapper.setProps({ panelKey: stagedId });
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(false);

		routerPush.mockClear();
		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(routerPush).toHaveBeenCalledWith(`/insights/${DASH_A}`);
		expect(insights.edits.create[0]).toMatchObject({ id: stagedId, type: 'metric', dashboard: DASH_A });
	});

	it('reconciles a restricted duplicate reopen so the preview matches the filtered POST', async () => {
		apiGet.mockImplementation(() => Promise.resolve({ data: { data: [] } }));

		const presets = { type: 'metric', dashboard: DASH_B, position_x: 1, position_y: 1, width: 8, height: 6 };

		const { wrapper, insights } = mountEditor('+', {
			permissions: [perm('create', ['name'], false, presets)],
			dashboardKey: DASH_A,
			realStaging: true,
		});

		await flushPromises();

		insights.edits.create.push(
			createPanelFixture({
				id: '_source',
				dashboard: DASH_A,
				type: 'time-series',
				options: { custom: true },
				name: 'Original',
				note: 'kept',
			})
		);

		insights.stagePanelDuplicate('_source');
		const dupId = insights.edits.create.at(-1)!.id;
		insights.stagePanelDelete('_source');

		await wrapper.setProps({ panelKey: dupId });
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(false);

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		const preview = insights.edits.create.find((entry) => entry.id === dupId)!;
		expect(preview).toMatchObject({ id: dupId, dashboard: DASH_B, type: 'metric', options: {}, name: 'Original' });
		expect(preview).not.toHaveProperty('note');

		await insights.saveChanges();

		const body = apiPost.mock.calls.find(([path]) => path === '/panels')?.[1] as Record<string, unknown>[];
		expect(body).toEqual([{ name: 'Original' }]);
	});

	it('preserves a non-writable preset dashboard in the preview and drops it from the POST', async () => {
		apiGet.mockImplementation(() => Promise.resolve({ data: { data: [] } }));

		const presets = { type: 'metric', dashboard: DASH_B, position_x: 1, position_y: 1, width: 8, height: 6 };

		const { wrapper, insights } = mountEditor('+', {
			permissions: [perm('create', ['name'], false, presets)],
			dashboardKey: DASH_A,
			realStaging: true,
		});

		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(false);

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(insights.edits.create[0]).toMatchObject({ dashboard: DASH_B });

		await insights.saveChanges();

		const body = apiPost.mock.calls.find(([path]) => path === '/panels')?.[1] as Record<string, unknown>[];
		expect(body[0]).not.toHaveProperty('dashboard');
	});

	it('follows the route dashboard when the target dashboard changes for a create', async () => {
		const { wrapper, insights } = mountEditor('+', { admin: true, dashboardKey: DASH_A });
		await flushPromises();

		typeSelect(wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(false);

		await wrapper.setProps({ dashboardKey: DASH_B });
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(true);

		typeSelect(wrapper).vm.$emit('update:modelValue', 'metric');
		await flushPromises();

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(insights.stagePanelCreate).toHaveBeenCalledWith(
			expect.objectContaining({ dashboard: DASH_B, type: 'metric' }),
			['*']
		);
	});

	it('discards a stale in-flight capability response when the target switches', async () => {
		const responses: Array<ReturnType<typeof deferred<{ data: { data: ItemPermissions } }>>> = [];

		apiGet.mockImplementation((path: string) => {
			if (!path.includes('/permissions/me')) return Promise.resolve({ data: { data: [] } });
			const d = deferred<{ data: { data: ItemPermissions } }>();
			responses.push(d);
			return d.promise;
		});

		const { wrapper } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'], true)],
			panels: [panelFixture(), panelFixture({ id: PANEL_B, name: 'Second' })],
		});

		await flushPromises();

		await wrapper.setProps({ panelKey: PANEL_B });
		await flushPromises();

		responses[0]!.resolve(itemCapability({ access: true, fields: ['*'] }));
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(true);

		responses[1]!.resolve(itemCapability({ access: true, fields: ['*'] }));
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(false);
	});

	it('discards a stale response when the same target is refreshed mid-flight', async () => {
		const responses: Array<ReturnType<typeof deferred<{ data: { data: ItemPermissions } }>>> = [];

		apiGet.mockImplementation((path: string) => {
			if (!path.includes('/permissions/me')) return Promise.resolve({ data: { data: [] } });
			const d = deferred<{ data: { data: ItemPermissions } }>();
			responses.push(d);
			return d.promise;
		});

		const { wrapper, insights } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'], true)],
			panels: [panelFixture()],
		});

		await flushPromises();

		setSavedPanels(insights, [panelFixture({ name: 'Refreshed' })]);
		await flushPromises();

		responses[0]!.resolve(itemCapability({ access: true, fields: ['*'] }));
		await flushPromises();
		expect(doneButton(wrapper).props('disabled')).toBe(true);

		responses[1]!.resolve(itemCapability({ access: true, fields: ['name'] }));
		await flushPromises();

		expect(doneButton(wrapper).props('disabled')).toBe(false);
		expect(fieldByPlaceholder(wrapper, 'panel_name_placeholder').props('disabled')).toBe(false);
		expect(fieldByPlaceholder(wrapper, 'panel_note_placeholder').props('disabled')).toBe(true);
	});

	it('preserves an in-progress draft when the underlying record refreshes mid-edit', async () => {
		const responses: Array<ReturnType<typeof deferred<{ data: { data: ItemPermissions } }>>> = [];

		apiGet.mockImplementation((path: string) => {
			if (!path.includes('/permissions/me')) return Promise.resolve({ data: { data: [] } });
			const d = deferred<{ data: { data: ItemPermissions } }>();
			responses.push(d);
			return d.promise;
		});

		const { wrapper, insights } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'], true)],
			panels: [panelFixture({ name: 'Stored' })],
			realStaging: true,
		});

		await flushPromises();

		responses[0]!.resolve(itemCapability({ access: true, fields: ['name'] }));
		await flushPromises();

		fieldByPlaceholder(wrapper, 'panel_name_placeholder').vm.$emit('update:modelValue', 'My Draft');
		await flushPromises();

		setSavedPanels(insights, [panelFixture({ name: 'Refreshed Stored' })]);
		await flushPromises();

		responses[1]!.resolve(itemCapability({ access: true, fields: ['name'] }));
		await flushPromises();

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		await insights.saveChanges();

		const patchBody = apiPatch.mock.calls.find(([path]) => path === '/panels')?.[1] as Record<string, unknown>[];
		expect(patchBody).toEqual([{ id: PANEL_A, name: 'My Draft' }]);
	});

	it('carries writable content from the editor through the store to a filtered PATCH', async () => {
		apiGet.mockImplementation((path: string) =>
			path.includes('/permissions/me')
				? Promise.resolve(itemCapability({ access: true, fields: ['name'] }))
				: Promise.resolve({ data: { data: [] } })
		);

		const { wrapper, insights } = mountEditor(PANEL_A, {
			permissions: [perm('update', ['*'], true)],
			panels: [panelFixture(), panelFixture({ id: PANEL_B, name: 'Other' })],
			realStaging: true,
		});

		await flushPromises();

		insights.stagePanelUpdate({ id: PANEL_B, edits: { note: 'Second' } });

		fieldByPlaceholder(wrapper, 'panel_name_placeholder').vm.$emit('update:modelValue', 'Renamed');
		await flushPromises();

		doneButton(wrapper).vm.$emit('click');
		await flushPromises();

		await insights.saveChanges();

		const patchBody = apiPatch.mock.calls.find(([path]) => path === '/panels')?.[1] as Record<string, unknown>[];

		expect(patchBody).toEqual(
			expect.arrayContaining([
				{ id: PANEL_A, name: 'Renamed' },
				{ id: PANEL_B, note: 'Second' },
			])
		);
	});
});
