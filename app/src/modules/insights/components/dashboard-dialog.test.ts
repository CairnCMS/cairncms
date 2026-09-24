import { i18n } from '@/lang';
import { router } from '@/router';
import { useInsightsStore } from '@/stores/insights';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { Dashboard } from '@/types/insights';
import { ItemPermissions, Permission } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import DashboardDialog from './dashboard-dialog.vue';

enableAutoUnmount(afterEach);

type Deferred = { promise: Promise<any>; resolve: (value: any) => void };

const { transport } = vi.hoisted(() => ({
	transport: {
		patches: [] as { path: string; payload: any }[],
		posts: [] as { path: string; payload: any }[],
		caps: {} as Record<string, any>,
		capRequests: [] as string[],
		capError: false,
		deferred: {} as Record<string, Deferred>,
	},
}));

vi.mock('@/api', () => ({
	default: {
		get: (path: string) => {
			if (path.startsWith('/permissions/me/')) {
				const id = decodeURIComponent(path.split('/').pop()!);
				transport.capRequests.push(id);
				if (transport.deferred[path]) return transport.deferred[path]!.promise;
				if (transport.capError) return Promise.reject(new Error('capability fetch failed'));
				return Promise.resolve({ data: { data: transport.caps[id] ?? null } });
			}

			return Promise.reject(new Error(`GET "${path}" is not mocked`));
		},
		patch: (path: string, payload: any) => {
			transport.patches.push({ path, payload });
			if (transport.deferred[path]) return transport.deferred[path]!.promise;
			return Promise.resolve({ data: { data: { id: 'd1' } } });
		},
		post: (path: string, payload: any) => {
			transport.posts.push({ path, payload });
			if (transport.deferred[path]) return transport.deferred[path]!.promise;
			return Promise.resolve({ data: { data: { id: 'new-id' } } });
		},
	},
}));

vi.mock('@/router', () => ({ router: { push: vi.fn() } }));

// eslint-disable-next-line vue/one-component-per-file
const VInput = defineComponent({
	name: 'VInput',
	props: { modelValue: { type: String, default: null }, disabled: { type: Boolean, default: false } },
	emits: ['update:modelValue'],
	template:
		'<input :disabled="disabled" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

// eslint-disable-next-line vue/one-component-per-file
const VButton = defineComponent({
	name: 'VButton',
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button class="v-button-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

const stubs = {
	'v-dialog': { props: ['modelValue'], template: '<div><slot name="activator" /><slot /></div>' },
	'v-card': { template: '<div><slot /></div>' },
	'v-card-title': { template: '<div><slot /></div>' },
	'v-card-text': { template: '<div><slot /></div>' },
	'v-card-actions': { template: '<div><slot /></div>' },
	'interface-select-icon': { props: ['value', 'disabled'], template: '<div class="icon-control" />' },
	'interface-select-color': { props: ['value', 'disabled'], template: '<div class="color-control" />' },
};

const dashboardA: Dashboard = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Sales',
	note: 'A note',
	icon: 'dashboard',
	color: '#abcabc',
	date_created: '2026-01-01T00:00:00Z',
	user_created: '99999999-9999-4999-8999-999999999999',
};

const dashboardB: Dashboard = {
	id: '22222222-2222-4222-8222-222222222222',
	name: 'Operations',
	note: 'B note',
	icon: 'insights',
	color: '#123123',
	date_created: '2026-02-02T00:00:00Z',
	user_created: '99999999-9999-4999-8999-999999999999',
};

const cap = (access: boolean, fields: string[] | null = ['*']): ItemPermissions => ({
	update: { access, fields },
	delete: { access: false },
	share: { access: false },
});

const conditionalUpdate: Permission = {
	role: 'role-1',
	collection: 'directus_dashboards',
	action: 'update',
	permissions: { user_created: { _eq: '$CURRENT_USER' } },
	validation: null,
	presets: null,
	fields: ['*'],
};

const unconditionalUpdate: Permission = {
	role: 'role-1',
	collection: 'directus_dashboards',
	action: 'update',
	permissions: {},
	validation: null,
	presets: null,
	fields: ['name'],
};

const create: Permission = {
	role: 'role-1',
	collection: 'directus_dashboards',
	action: 'create',
	permissions: {},
	validation: null,
	presets: null,
	fields: ['*'],
};

function capPath(id: string) {
	return `/permissions/me/directus_dashboards/${id}`;
}

function defer(path: string) {
	let resolve: (value: any) => void = () => undefined;
	const promise = new Promise((res) => (resolve = res));
	transport.deferred[path] = { promise, resolve };
	return { resolve };
}

function mountDialog(props: Record<string, any>, permissions: Permission[] = [], admin = false) {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: admin } };
	(usePermissionsStore() as any).permissions = permissions;
	(useInsightsStore() as any).hydrate = vi.fn();

	return mount(DashboardDialog, {
		props: { modelValue: true, ...props },
		global: { plugins: [i18n, pinia], stubs, components: { VInput, VButton }, directives: { tooltip: {} } },
	});
}

function saveButton(wrapper: ReturnType<typeof mountDialog>) {
	return wrapper.findAllComponents(VButton)[1]!;
}

function nameInput(wrapper: ReturnType<typeof mountDialog>) {
	return wrapper.findAllComponents(VInput)[0]!;
}

function closeEvents(wrapper: ReturnType<typeof mountDialog>) {
	return (wrapper.emitted('update:modelValue') ?? []).filter(([value]) => value === false).length;
}

beforeEach(() => {
	transport.patches = [];
	transport.posts = [];
	transport.caps = {};
	transport.capRequests = [];
	transport.capError = false;
	transport.deferred = {};
	(router.push as any).mockClear();
});

describe('insights dashboard-dialog capability gating', () => {
	it('submits only the writable fields, using the edited value', async () => {
		transport.caps[dashboardA.id] = cap(true, ['name']);

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();

		await nameInput(wrapper).setValue('Edited');
		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(transport.patches).toHaveLength(1);
		expect(transport.patches[0]!.payload).toEqual({ name: 'Edited' });
	});

	it('disables the non-writable controls', async () => {
		transport.caps[dashboardA.id] = cap(true, ['name']);

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();

		expect(nameInput(wrapper).props('disabled')).toBe(false);
		expect(wrapper.findAllComponents(VInput)[1]!.props('disabled')).toBe(true);
		expect(wrapper.findComponent('.icon-control').props('disabled')).toBe(true);
		expect(wrapper.findComponent('.color-control').props('disabled')).toBe(true);
	});

	it('writes only the permitted fields for an unconditional restricted update without a capability request', async () => {
		const wrapper = mountDialog({ dashboard: dashboardA }, [unconditionalUpdate]);
		await flushPromises();

		expect(transport.capRequests).toHaveLength(0);
		expect(nameInput(wrapper).props('disabled')).toBe(false);
		expect(wrapper.findAllComponents(VInput)[1]!.props('disabled')).toBe(true);

		await nameInput(wrapper).setValue('Renamed');
		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(transport.patches).toHaveLength(1);
		expect(transport.patches[0]!.payload).toEqual({ name: 'Renamed' });
	});

	it('keeps save unavailable until the capability resolves', async () => {
		const pending = defer(capPath(dashboardA.id));

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();
		expect(transport.patches).toHaveLength(0);

		pending.resolve({ data: { data: cap(true) } });
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('keeps save unavailable when the capability request fails', async () => {
		transport.capError = true;

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(transport.patches).toHaveLength(0);
	});

	it('does not write when the handler runs after a denied update', async () => {
		transport.caps[dashboardA.id] = cap(false, null);

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(transport.patches).toHaveLength(0);
	});

	it('does not write when the handler runs after the dialog is closed', async () => {
		transport.caps[dashboardA.id] = cap(true);

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();
		await wrapper.setProps({ modelValue: false });

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(transport.patches).toHaveLength(0);
	});

	it('keeps save unavailable when no dialog field is writable', async () => {
		transport.caps[dashboardA.id] = cap(true, []);

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(transport.patches).toHaveLength(0);
	});

	it('creates only with create availability and issues no capability request', async () => {
		const wrapper = mountDialog({ dashboard: undefined }, [create]);
		await flushPromises();

		expect(transport.capRequests).toHaveLength(0);

		await nameInput(wrapper).setValue('Fresh');
		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(transport.posts).toHaveLength(1);
		expect(transport.posts[0]!.payload).toMatchObject({ name: 'Fresh' });
	});

	it('does not create without a create grant', async () => {
		const wrapper = mountDialog({ dashboard: undefined }, []);
		await flushPromises();

		await nameInput(wrapper).setValue('Fresh');
		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(transport.posts).toHaveLength(0);
	});

	it('does not create when the name is unset', async () => {
		const wrapper = mountDialog({ dashboard: undefined }, [create]);
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(transport.posts).toHaveLength(0);
	});

	it('creates with a preset name without submitting the non-writable name', async () => {
		const presetCreate: Permission = {
			role: 'role-1',
			collection: 'directus_dashboards',
			action: 'create',
			permissions: {},
			validation: null,
			presets: { name: 'Preset Dashboard' },
			fields: ['note'],
		};

		const wrapper = mountDialog({ dashboard: undefined }, [presetCreate]);
		await flushPromises();

		expect(nameInput(wrapper).props('disabled')).toBe(true);
		expect(nameInput(wrapper).props('modelValue')).toBe('Preset Dashboard');
		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();

		await wrapper.findAllComponents(VInput)[1]!.setValue('a note');
		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(transport.posts).toHaveLength(1);
		expect(transport.posts[0]!.payload).toEqual({ note: 'a note' });
	});

	it('prefills an editable preset name and blocks clearing it', async () => {
		const editablePresetCreate: Permission = {
			role: 'role-1',
			collection: 'directus_dashboards',
			action: 'create',
			permissions: {},
			validation: null,
			presets: { name: 'Preset Editable' },
			fields: ['name', 'note'],
		};

		const wrapper = mountDialog({ dashboard: undefined }, [editablePresetCreate]);
		await flushPromises();

		expect(nameInput(wrapper).props('disabled')).toBe(false);
		expect(nameInput(wrapper).props('modelValue')).toBe('Preset Editable');
		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();

		await nameInput(wrapper).setValue('');
		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(transport.posts).toHaveLength(0);
	});

	it('allows a zero-input create backed entirely by a preset', async () => {
		const presetOnlyCreate: Permission = {
			role: 'role-1',
			collection: 'directus_dashboards',
			action: 'create',
			permissions: {},
			validation: null,
			presets: { name: 'Preset Only' },
			fields: [],
		};

		const wrapper = mountDialog({ dashboard: undefined }, [presetOnlyCreate]);
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();

		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(transport.posts).toHaveLength(1);
		expect(transport.posts[0]!.payload).toEqual({});
	});

	it('blocks a create when the name is neither writable nor preset-supplied', async () => {
		const noNameCreate: Permission = {
			role: 'role-1',
			collection: 'directus_dashboards',
			action: 'create',
			permissions: {},
			validation: null,
			presets: null,
			fields: ['note'],
		};

		const wrapper = mountDialog({ dashboard: undefined }, [noNameCreate]);
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(transport.posts).toHaveLength(0);
	});

	it('issues a single write for immediate repeated save events', async () => {
		defer('/dashboards');

		const wrapper = mountDialog({ dashboard: undefined }, [create]);
		await flushPromises();

		await nameInput(wrapper).setValue('Fresh');
		saveButton(wrapper).vm.$emit('click');
		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(transport.posts).toHaveLength(1);
	});

	it('submits every field for an admin without a capability request', async () => {
		const wrapper = mountDialog({ dashboard: dashboardA }, [], true);
		await flushPromises();

		expect(transport.capRequests).toHaveLength(0);

		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(transport.patches[0]!.payload).toEqual({
			name: 'Sales',
			icon: 'dashboard',
			color: '#abcabc',
			note: 'A note',
		});
	});

	it('binds the emitted payload to the switched dashboard target', async () => {
		transport.caps[dashboardA.id] = cap(true);
		transport.caps[dashboardB.id] = cap(true);

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();

		await wrapper.setProps({ dashboard: dashboardB });
		await flushPromises();

		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(transport.patches[0]!.path).toContain(dashboardB.id);
		expect(transport.patches[0]!.payload).toMatchObject({ name: 'Operations' });
	});

	it('refreshes the capability when the same-id dashboard object is replaced', async () => {
		transport.caps[dashboardA.id] = cap(true);

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();
		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();

		transport.caps[dashboardA.id] = cap(false, null);
		await wrapper.setProps({ dashboard: { ...dashboardA, name: 'Sales v2' } });
		await flushPromises();

		expect(transport.capRequests.filter((id) => id === dashboardA.id)).toHaveLength(2);
		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
	});

	it('preserves the typed draft when the same-id dashboard object is replaced', async () => {
		transport.caps[dashboardA.id] = cap(true);

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();

		await nameInput(wrapper).setValue('Unsaved draft');
		await wrapper.setProps({ dashboard: { ...dashboardA, name: 'Server refresh' } });
		await flushPromises();

		await saveButton(wrapper).trigger('click');
		await flushPromises();

		expect(transport.patches).toHaveLength(1);
		expect(transport.patches[0]!.payload).toMatchObject({ name: 'Unsaved draft' });
	});

	it('does not redirect after the dialog unmounts mid-create', async () => {
		const pending = defer('/dashboards');

		const wrapper = mountDialog({ dashboard: undefined }, [create]);
		await flushPromises();

		await nameInput(wrapper).setValue('Fresh');
		await saveButton(wrapper).trigger('click');
		expect(transport.posts).toHaveLength(1);

		wrapper.unmount();
		pending.resolve({ data: { data: { id: 'new-id' } } });
		await flushPromises();

		expect(router.push).not.toHaveBeenCalled();
	});

	it('keeps a superseded save from disturbing a reopened editor session', async () => {
		transport.caps[dashboardA.id] = cap(true);
		transport.caps[dashboardB.id] = cap(true);
		const pendingA = defer(`/dashboards/${dashboardA.id}`);
		const pendingB = defer(`/dashboards/${dashboardB.id}`);

		const wrapper = mountDialog({ dashboard: dashboardA }, [conditionalUpdate]);
		await flushPromises();

		await saveButton(wrapper).trigger('click');

		await wrapper.setProps({ modelValue: false });
		await wrapper.setProps({ modelValue: true, dashboard: dashboardB });
		await flushPromises();

		await saveButton(wrapper).trigger('click');
		const closesBeforeResolve = closeEvents(wrapper);

		pendingA.resolve({ data: { data: { id: dashboardA.id } } });
		await flushPromises();

		expect(closeEvents(wrapper)).toBe(closesBeforeResolve);
		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		pendingB.resolve({ data: { data: { id: dashboardB.id } } });
		await flushPromises();

		expect(closeEvents(wrapper)).toBe(closesBeforeResolve + 1);
	});
});
