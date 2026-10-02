import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { computed, defineComponent, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import type { AppCollection, CollectionMeta, Field, FieldMeta, Permission } from '@cairncms/types';
import type { Column } from '@cairncms/schema';
import type { UsableCollection } from '@cairncms/composables';

type ApiResponse = { data: { data: any } };
type ApiRequest = (url: string, payload?: Record<string, unknown>) => Promise<ApiResponse>;

const { apiState, shortcuts } = vi.hoisted(() => ({
	apiState: {
		get: vi.fn<ApiRequest>(),
		patch: vi.fn<ApiRequest>(),
		post: vi.fn<ApiRequest>(),
	},
	shortcuts: new Map<string, () => void>(),
}));

vi.mock('@/api', () => ({
	default: {
		get: (path: string, config?: Record<string, unknown>) => apiState.get(path, config),
		patch: (path: string, payload?: Record<string, unknown>) => apiState.patch(path, payload),
		post: (path: string, payload?: Record<string, unknown>) => apiState.post(path, payload),
	},
}));

vi.mock('@cairncms/composables');

vi.mock('@/lang', () => ({ i18n: { global: { t: (key: string) => key } } }));
vi.mock('@/utils/notify', () => ({ notify: vi.fn() }));

vi.mock('@/composables/use-shortcut', () => ({
	useShortcut: (keys: string, handler: () => void) => {
		shortcuts.set(keys, handler);
	},
}));

vi.mock('@/composables/use-edits-guard', () => ({
	useEditsGuard: () => ({ confirmLeave: ref(false), leaveTo: ref(null) }),
}));

vi.mock('@/composables/use-template-data', () => ({
	useTemplateData: () => ({ templateData: ref({}), loading: ref(false) }),
}));

vi.mock('@/composables/use-item-views', () => ({
	itemViewKey: () => 'view',
	useItemViews: () => ({
		itemViews: ref([]),
		activeItemView: ref(null),
		splitViewOpen: ref(false),
		itemViewContext: {},
		toggleItemView: vi.fn(),
		notifyItemViewSaved: vi.fn(),
	}),
}));

vi.mock('@/composables/use-title', () => ({ useTitle: vi.fn() }));

vi.mock('vue-router', async (importOriginal) => ({
	...(await importOriginal<typeof import('vue-router')>()),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), options: { history: { state: {} } } }),
	useRoute: () => ({ params: {}, query: {} }),
	onBeforeRouteLeave: vi.fn(),
	onBeforeRouteUpdate: vi.fn(),
}));

import { useCollection } from '@cairncms/composables';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import ContentItem from './item.vue';

enableAutoUnmount(afterEach);

const i18n = createI18n({ legacy: false });

const COLLECTION = 'test_singleton';
const ROLE = 'role-1';

// eslint-disable-next-line vue/one-component-per-file
const VButton = defineComponent({
	name: 'VButton',
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /><slot name="append-outer" /></button>',
});

// eslint-disable-next-line vue/one-component-per-file
const VIcon = defineComponent({
	name: 'VIcon',
	props: { name: { type: String, default: '' } },
	template: '<i :data-name="name" />',
});

// eslint-disable-next-line vue/one-component-per-file
const VForm = defineComponent({
	name: 'VForm',
	props: {
		modelValue: { type: Object, default: () => ({}) },
		validationErrors: { type: Array, default: () => [] },
	},
	emits: ['update:modelValue'],
	template: '<div class="v-form" />',
});

const PrivateView = {
	template: '<div><slot /><slot name="actions" /><slot name="title-outer:prepend" /></div>',
};

const otherStubs = [
	'content-not-found',
	'content-navigation',
	'render-template',
	'v-breadcrumb',
	'v-card',
	'v-card-actions',
	'v-card-text',
	'v-card-title',
	'v-dialog',
	'v-skeleton-loader',
	'save-options',
	'sidebar-detail',
	'revisions-drawer-detail',
	'comments-sidebar-detail',
	'shares-sidebar-detail',
	'flow-sidebar-detail',
].reduce((stubs, name) => ({ ...stubs, [name]: true }), {} as Record<string, boolean>);

function column(partial: Partial<Column> & Pick<Column, 'name'>): Column {
	return {
		name: partial.name,
		table: COLLECTION,
		data_type: 'string',
		default_value: null,
		max_length: null,
		numeric_precision: null,
		numeric_scale: null,
		is_nullable: true,
		is_unique: false,
		is_primary_key: false,
		is_generated: false,
		has_auto_increment: false,
		foreign_key_table: null,
		foreign_key_column: null,
		...partial,
	};
}

function fieldMeta(partial: Partial<FieldMeta> & Pick<FieldMeta, 'field'>): FieldMeta {
	return {
		id: 1,
		collection: COLLECTION,
		field: partial.field,
		group: null,
		hidden: false,
		interface: null,
		display: null,
		options: null,
		display_options: null,
		readonly: false,
		required: false,
		sort: null,
		special: null,
		translations: null,
		width: 'full',
		note: null,
		conditions: null,
		validation: null,
		validation_message: null,
		...partial,
	};
}

function makeField(partial: Partial<Field> & Pick<Field, 'field'>): Field {
	return {
		collection: COLLECTION,
		field: partial.field,
		type: 'string',
		name: partial.field,
		schema: null,
		meta: null,
		...partial,
	};
}

function collectionMeta(): CollectionMeta {
	return {
		collection: COLLECTION,
		note: null,
		hidden: false,
		singleton: true,
		icon: 'box',
		color: null,
		translations: null,
		display_template: null,
		sort_field: null,
		archive_field: null,
		archive_value: null,
		unarchive_value: null,
		archive_app_filter: true,
		item_duplication_fields: null,
		accountability: 'all',
		sort: null,
		group: null,
		collapse: 'open',
	};
}

function appCollection(): AppCollection {
	return {
		collection: COLLECTION,
		meta: collectionMeta(),
		schema: null,
		name: 'Settings',
		icon: 'box',
		type: 'table',
		color: null,
	};
}

const idField = makeField({
	field: 'id',
	type: 'integer',
	schema: column({
		name: 'id',
		data_type: 'integer',
		is_primary_key: true,
		has_auto_increment: true,
		is_nullable: false,
	}),
	meta: fieldMeta({ field: 'id', hidden: true }),
});

function fields(options: { required?: boolean } = {}): Field[] {
	const list: Field[] = [idField, makeField({ field: 'name' })];

	if (options.required) {
		list.push(makeField({ field: 'required_field', meta: fieldMeta({ field: 'required_field', required: true }) }));
	}

	return list;
}

type Grants = {
	create?: boolean;
	createFields?: string[];
	createPresets?: Record<string, any> | null;
	update?: boolean;
	updateFields?: string[];
};

function grants(options: Grants): Permission[] {
	const permission = (partial: Pick<Permission, 'action' | 'fields'> & Partial<Permission>): Permission => ({
		role: ROLE,
		collection: COLLECTION,
		permissions: null,
		validation: null,
		presets: null,
		...partial,
	});

	const permissions: Permission[] = [permission({ action: 'read', fields: ['*'] })];

	if (options.create) {
		permissions.push(
			permission({ action: 'create', fields: options.createFields ?? [], presets: options.createPresets ?? null })
		);
	}

	if (options.update) {
		permissions.push(permission({ action: 'update', fields: options.updateFields ?? ['name'] }));
	}

	return permissions;
}

function mockCollection(options: { required?: boolean } = {}) {
	const collection: UsableCollection = {
		info: computed(() => appCollection()),
		fields: computed(() => fields(options)),
		defaults: computed(() => ({})),
		primaryKeyField: computed(() => idField),
		userCreatedField: computed(() => null),
		sortField: computed(() => null),
		isSingleton: computed(() => true),
		accountabilityScope: computed(() => 'all'),
	};

	vi.mocked(useCollection).mockReturnValue(collection);
}

type SetupOptions = Grants & { get?: Mock<ApiRequest>; required?: boolean };

function setup(options: SetupOptions = {}) {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { id: 'u1', role: { id: ROLE, admin_access: false } };

	(usePermissionsStore() as any).permissions = grants({
		create: true,
		createPresets: { name: 'preset-name' },
		...options,
	});

	mockCollection({ required: options.required });

	apiState.get = options.get ?? vi.fn<ApiRequest>(() => Promise.resolve({ data: { data: { id: null } } }));
	apiState.patch = vi.fn<ApiRequest>(() => Promise.resolve({ data: { data: { id: 1 } } }));
	apiState.post = vi.fn<ApiRequest>(() => Promise.resolve({ data: { data: { id: 1 } } }));

	const wrapper = shallowMount(ContentItem, {
		props: { collection: COLLECTION, primaryKey: null, singleton: true },
		global: {
			plugins: [i18n, pinia],
			stubs: { 'private-view': PrivateView, 'v-button': VButton, 'v-icon': VIcon, 'v-form': VForm, ...otherStubs },
			directives: { tooltip: {}, md: {} },
		},
	});

	return wrapper;
}

function saveButton(wrapper: ReturnType<typeof setup>) {
	return wrapper.findAllComponents(VButton).find((button) => button.html().includes('data-name="check"'))!;
}

beforeEach(() => {
	shortcuts.clear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('content item singleton save availability', () => {
	it('enables Save for a preset-only empty singleton whose preset supplies the required content', async () => {
		const wrapper = setup({ required: true, createPresets: { name: 'preset-name', required_field: 'from-preset' } });
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(false);

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(apiState.patch).toHaveBeenCalledTimes(1);
		expect(apiState.patch).toHaveBeenCalledWith(`/items/${COLLECTION}`, {});
	});

	it('saves a preset-only empty singleton through the save shortcut', async () => {
		setup();
		await flushPromises();

		shortcuts.get('meta+s')!();
		await flushPromises();

		expect(apiState.patch).toHaveBeenCalledTimes(1);
		expect(apiState.patch).toHaveBeenCalledWith(`/items/${COLLECTION}`, {});
	});

	it('disables Save for an empty singleton without a create permission', async () => {
		const wrapper = setup({ create: false });
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(true);

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(apiState.patch).not.toHaveBeenCalled();
	});

	it('disables Save while the singleton is still loading', async () => {
		let resolveGet: (value: ApiResponse) => void = () => undefined;
		const get = vi.fn<ApiRequest>(() => new Promise((resolve) => (resolveGet = resolve)));

		const wrapper = setup({ get });

		expect(saveButton(wrapper).props('disabled')).toBe(true);

		resolveGet({ data: { data: { id: null } } });
		await flushPromises();
	});

	it('does not offer Save when the singleton load fails', async () => {
		const get = vi.fn<ApiRequest>(() => Promise.reject(new Error('fail')));

		const wrapper = setup({ get });
		await flushPromises();

		expect(saveButton(wrapper)).toBeUndefined();
	});

	it('disables Save for an existing singleton with no edits despite an update grant', async () => {
		const get = vi.fn<ApiRequest>(() => Promise.resolve({ data: { data: { id: 1, name: 'existing' } } }));

		const wrapper = setup({ create: false, update: true, updateFields: ['name'], get });
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(true);

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(apiState.patch).not.toHaveBeenCalled();
	});

	it('sends the edited fields when an empty singleton is edited before saving', async () => {
		const wrapper = setup({ createFields: ['name'] });
		await flushPromises();

		wrapper.findComponent(VForm).vm.$emit('update:modelValue', { name: 'edited' });
		await flushPromises();

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(apiState.patch).toHaveBeenCalledWith(`/items/${COLLECTION}`, { name: 'edited' });
	});

	it('does not bypass required-field validation when the preset omits it', async () => {
		const wrapper = setup({ required: true });
		await flushPromises();

		expect(saveButton(wrapper).props('disabled')).toBe(false);

		saveButton(wrapper).vm.$emit('click');
		await flushPromises();

		expect(apiState.patch).not.toHaveBeenCalled();

		const errors = wrapper.findComponent(VForm).props('validationErrors') as Array<{ field?: string }>;
		expect(errors.some((error) => error.field === 'required_field')).toBe(true);
	});
});
