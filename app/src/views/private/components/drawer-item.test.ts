import { i18n } from '@/lang';
import { useFieldsStore } from '@/stores/fields';
import { usePermissionsStore } from '@/stores/permissions';
import { useRelationsStore } from '@/stores/relations';
import { useUserStore } from '@/stores/user';
import { STORES_INJECT } from '@cairncms/constants';
import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import DrawerItem from './drawer-item.vue';

enableAutoUnmount(afterEach);

type Deferred = { promise: Promise<any>; resolve: (value: any) => void; reject: (error: any) => void };

const { transport } = vi.hoisted(() => ({
	transport: {
		paths: [] as string[],
		capabilities: {} as Record<string, any>,
		items: {} as Record<string, any>,
		deferred: {} as Record<string, Deferred>,
		fail: {} as Record<string, boolean>,
	},
}));

vi.mock('@/api', () => ({
	default: {
		get: (path: string) => {
			transport.paths.push(path);

			if (transport.deferred[path]) return transport.deferred[path]!.promise;
			if (transport.fail[path]) return Promise.reject(new Error(`GET "${path}" failed`));

			if (path.startsWith('/permissions/me/')) {
				const parts = path.split('/');
				const key = `${decodeURIComponent(parts[3]!)}/${decodeURIComponent(parts[4]!)}`;
				return Promise.resolve({ data: { data: transport.capabilities[key] ?? null } });
			}

			return Promise.resolve({ data: { data: transport.items[path] ?? {} } });
		},
	},
}));

vi.mock('vue-router', async (importOriginal) => ({
	...(await importOriginal<typeof import('vue-router')>()),
	useRoute: () => ({ path: '/' }),
	useRouter: () => ({ push: vi.fn() }),
	onBeforeRouteUpdate: vi.fn(),
	onBeforeRouteLeave: vi.fn(),
}));

function defer(path: string) {
	let resolve: (value: any) => void = () => undefined;
	let reject: (error: any) => void = () => undefined;

	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});

	transport.deferred[path] = { promise, resolve, reject };
	return { resolve, reject };
}

const field = (collection: string, name: string, extra: Record<string, any> = {}) => ({
	collection,
	field: name,
	type: 'string',
	schema: { is_primary_key: name === 'id', default_value: null },
	meta: { hidden: false },
	...extra,
});

const allFields = [
	field('articles', 'id'),
	field('articles', 'title'),
	field('articles', 'body'),
	field('articles_categories', 'id'),
	field('articles_categories', 'sort'),
	field('articles_categories', 'category', { meta: { hidden: false, required: true } }),
	field('categories', 'id'),
	field('categories', 'name'),
	field('posts_tags', 'id'),
	field('posts_tags', 'weight', { meta: { hidden: false, required: true } }),
	field('posts_tags', 'tag'),
	field('tags', 'id'),
	field('tags', 'label'),
	field('blocks', 'id'),
	field('blocks', 'sort'),
	field('blocks', 'collection'),
	field('blocks', 'item'),
	field('paragraphs', 'id'),
	field('paragraphs', 'text'),
	field('paragraphs', 'title'),
	field('snippets', 'id'),
	field('snippets', 'code'),
	field('snippets', 'title'),
	field('docs_authors', 'id'),
	field('docs_authors', 'author'),
	field('authors', 'id'),
	field('authors', 'name', { meta: { hidden: false, required: true } }),
];

const fieldsFor = (collection: string) => allFields.filter((entry) => entry.collection === collection);

const collections = [
	'articles',
	'articles_categories',
	'categories',
	'posts_tags',
	'tags',
	'blocks',
	'paragraphs',
	'snippets',
	'docs_authors',
	'authors',
].map((collection) => ({ collection, meta: {} }));

const relations = [
	{
		collection: 'articles_categories',
		field: 'category',
		related_collection: 'categories',
		meta: { junction_field: null, one_field: null, one_collection_field: null },
	},
	{
		collection: 'posts_tags',
		field: 'tag',
		related_collection: 'tags',
		meta: { junction_field: null, one_field: null, one_collection_field: null },
	},
	{
		collection: 'blocks',
		field: 'item',
		related_collection: null,
		meta: { junction_field: null, one_field: null, one_collection_field: 'collection' },
	},
	{
		collection: 'docs_authors',
		field: 'author',
		related_collection: 'authors',
		meta: { junction_field: null, one_field: null, one_collection_field: null },
	},
];

// eslint-disable-next-line vue/one-component-per-file
const VForm = defineComponent({
	name: 'VForm',
	props: {
		disabled: { type: Boolean, default: false },
		modelValue: { type: Object, default: undefined },
		initialValues: { type: Object, default: undefined },
		primaryKey: { type: [String, Number], default: undefined },
		validationErrors: { type: Array, default: () => [] },
		fields: { type: Array, default: () => [] },
	},
	emits: ['update:modelValue'],
	template: '<div class="v-form-stub" />',
});

// eslint-disable-next-line vue/one-component-per-file
const VButton = defineComponent({
	name: 'VButton',
	props: { disabled: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<button class="v-button-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

const stubs = {
	'v-drawer': { template: '<div><slot name="actions" /><slot /></div>' },
	'v-dialog': { props: ['modelValue'], template: '<div v-if="modelValue"><slot /></div>' },
	'v-icon': { props: ['name'], template: '<i :data-name="name" />' },
	'v-info': { template: '<div><slot /></div>' },
	'v-skeleton-loader': { template: '<div />' },
	'render-template': { template: '<div />' },
	'v-breadcrumb': { template: '<div />' },
	'v-card': { template: '<div><slot /></div>' },
	'v-card-title': { template: '<div><slot /></div>' },
	'v-card-text': { template: '<div><slot /></div>' },
	'v-card-actions': { template: '<div><slot /></div>' },
	'file-preview': { template: '<div />' },
};

function mountDrawer(props: Record<string, any>, options: { admin?: boolean; permissions?: any[] } = {}) {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: options.admin === true } };
	(usePermissionsStore() as any).permissions = options.permissions ?? [];
	(useFieldsStore() as any).fields = allFields;
	(useRelationsStore() as any).relations = relations;

	return mount(DrawerItem, {
		props: { active: true, ...props },
		global: {
			plugins: [i18n, pinia],
			stubs,
			directives: { tooltip: {} },
			components: { VForm, VButton },
			provide: {
				[STORES_INJECT]: {
					useCollectionsStore: () => ({ collections }),
					useFieldsStore: () => ({ getFieldsForCollectionSorted: (collection: string) => fieldsFor(collection) }),
				},
			},
		},
	});
}

function forms(wrapper: ReturnType<typeof mountDrawer>) {
	return wrapper.findAllComponents(VForm);
}

function saveButton(wrapper: ReturnType<typeof mountDrawer>) {
	return wrapper.find('button.v-button-stub');
}

function invokeSave(wrapper: ReturnType<typeof mountDrawer>) {
	return wrapper.findComponent(VButton).vm.$emit('click');
}

function emittedPayload(wrapper: ReturnType<typeof mountDrawer>) {
	return wrapper.emitted('input')?.[0]?.[0] as Record<string, any> | undefined;
}

const cap = (access: boolean, fields: string[] | null = ['*']) => ({
	update: { access, fields },
	delete: { access: false },
	share: { access: false },
});

const conditionalUpdate = (collection: string) => ({
	collection,
	action: 'update',
	role: 'role-1',
	permissions: { owner: { _eq: '$CURRENT_USER' } },
	fields: ['*'],
});

const create = (collection: string) => ({
	collection,
	action: 'create',
	role: 'role-1',
	permissions: {},
	fields: ['*'],
});

beforeEach(() => {
	transport.paths = [];
	transport.capabilities = {};
	transport.items = {};
	transport.deferred = {};
	transport.fail = {};
});

describe('drawer-item single-item gating', () => {
	it('follows the server capability for an existing ordinary item', async () => {
		transport.capabilities['articles/5'] = cap(true);
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing' };

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { title: 'Changed' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await flushPromises();

		expect(transport.paths.filter((path) => path.startsWith('/permissions/me/'))).toEqual([
			'/permissions/me/articles/5',
		]);

		expect(forms(wrapper)[0]!.props('disabled')).toBe(false);
		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('disables an existing ordinary item when the server denies update', async () => {
		transport.capabilities['articles/5'] = cap(false, null);
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing' };

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { title: 'Changed' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await flushPromises();

		expect(forms(wrapper)[0]!.props('disabled')).toBe(true);
		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
	});

	it('lets a create-only user open a new item without a capability request', async () => {
		const wrapper = mountDrawer({ collection: 'articles', primaryKey: '+' }, { permissions: [create('articles')] });

		await flushPromises();

		expect(transport.paths.some((path) => path.startsWith('/permissions/me/'))).toBe(false);
		expect(forms(wrapper)[0]!.props('disabled')).toBe(false);
		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('preserves a numeric key of 0 through the capability request and the emitted payload', async () => {
		transport.capabilities['articles/0'] = cap(true);
		transport.items['/items/articles/0'] = { id: 0, title: 'Zero' };

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: 0, edits: { title: 'Changed' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await flushPromises();

		expect(transport.paths).toContain('/permissions/me/articles/0');
		expect(transport.paths).toContain('/items/articles/0');

		await saveButton(wrapper).trigger('click');

		expect(emittedPayload(wrapper)?.id).toBe(0);
	});

	it('holds Save disabled for an admin until the existing item finishes loading', async () => {
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing' };
		const load = defer('/items/articles/5');

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { title: 'Changed' } },
			{ admin: true }
		);

		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
		expect(forms(wrapper)[0]!.props('disabled')).toBe(true);

		load.resolve({ data: { data: { id: '5', title: 'Existing' } } });
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
		expect(forms(wrapper)[0]!.props('disabled')).toBe(false);
	});

	it('keeps an unconditional role unavailable when the existing item read fails', async () => {
		transport.fail['/items/articles/5'] = true;

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { title: 'Changed' } },
			{ permissions: [{ collection: 'articles', action: 'update', role: 'role-1', permissions: {}, fields: ['*'] }] }
		);

		await flushPromises();

		expect(forms(wrapper)[0]!.props('disabled')).toBe(true);
		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
	});

	it('emits only the writable fields the capability grants', async () => {
		transport.capabilities['articles/5'] = cap(true, ['title']);
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing', body: 'Body' };

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { title: 'Changed', body: 'Rewritten' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await flushPromises();
		await saveButton(wrapper).trigger('click');

		const payload = emittedPayload(wrapper)!;
		expect(payload.title).toBe('Changed');
		expect('body' in payload).toBe(false);
		expect(payload.id).toBe('5');
	});

	it('marks a subset-restricted field readonly in the opened form', async () => {
		transport.capabilities['articles/5'] = cap(true, ['title']);
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing', body: 'Body' };

		const restrictedUpdate = {
			collection: 'articles',
			action: 'update',
			role: 'role-1',
			permissions: { owner: { _eq: '$CURRENT_USER' } },
			fields: ['title'],
		};

		const wrapper = mountDrawer({ collection: 'articles', primaryKey: '5' }, { permissions: [restrictedUpdate] });
		await flushPromises();

		const mainForm = forms(wrapper).find((form) => (form.props('fields') as any[]).some((f) => f.field === 'title'))!;
		const formFields = mainForm.props('fields') as any[];
		expect(formFields.find((f) => f.field === 'body').meta.readonly).toBe(true);
		expect(formFields.find((f) => f.field === 'title').meta.readonly).toBeFalsy();
	});

	it('marks every field readonly for a null-field update grant', async () => {
		transport.capabilities['articles/5'] = cap(true, null);
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing', body: 'Body' };

		const nullUpdate = {
			collection: 'articles',
			action: 'update',
			role: 'role-1',
			permissions: { owner: { _eq: '$CURRENT_USER' } },
			fields: null,
		};

		const wrapper = mountDrawer({ collection: 'articles', primaryKey: '5' }, { permissions: [nullUpdate] });
		await flushPromises();

		const mainForm = forms(wrapper).find((form) => (form.props('fields') as any[]).some((f) => f.field === 'title'))!;
		const formFields = mainForm.props('fields') as any[];
		expect(formFields.every((f) => f.meta.readonly === true)).toBe(true);
	});

	it('emits an empty default-only create validated by a preset for a required field', async () => {
		const presetCreate = {
			collection: 'authors',
			action: 'create',
			role: 'role-1',
			permissions: {},
			fields: [],
			presets: { name: 'From Preset' },
		};

		const wrapper = mountDrawer({ collection: 'authors', primaryKey: '+' }, { permissions: [presetCreate] });
		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();

		await saveButton(wrapper).trigger('click');

		expect(emittedPayload(wrapper)).toEqual({});

		const mainForm = forms(wrapper).find((form) => (form.props('fields') as any[]).some((f) => f.field === 'name'))!;
		expect(mainForm.props('validationErrors')).toEqual([]);
	});

	it('does not enable Save for an existing item whose only staged key is its identifier', async () => {
		transport.capabilities['articles/5'] = cap(true);
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing' };

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { id: '5' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
	});

	it('emits nothing when the save handler is invoked after the drawer is disabled', async () => {
		transport.capabilities['articles/5'] = cap(true);
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing' };

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { title: 'Changed' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await flushPromises();
		await wrapper.setProps({ disabled: true });
		invokeSave(wrapper);
		await flushPromises();

		expect(wrapper.emitted('input')).toBeUndefined();
	});

	it('emits nothing when the save handler is invoked after the drawer closes', async () => {
		transport.capabilities['articles/5'] = cap(true);
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing' };

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { title: 'Changed' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await flushPromises();
		await wrapper.setProps({ active: false });
		invokeSave(wrapper);
		await flushPromises();

		expect(wrapper.emitted('input')).toBeUndefined();
	});

	it('preserves staging identity while dropping non-writable fields in the emitted payload', async () => {
		const wrapper = mountDrawer(
			{
				collection: 'articles',
				primaryKey: '+',
				edits: { title: 'Revised', body: 'Nope', $type: 'created', $index: 0 },
			},
			{
				permissions: [{ collection: 'articles', action: 'create', role: 'role-1', permissions: {}, fields: ['title'] }],
			}
		);

		await flushPromises();
		invokeSave(wrapper);
		await flushPromises();

		const payload = emittedPayload(wrapper)!;
		expect(payload).toMatchObject({ title: 'Revised', $type: 'created', $index: 0 });
		expect('body' in payload).toBe(false);
	});

	it('does not enable Save when only a non-writable field is staged', async () => {
		transport.capabilities['articles/5'] = cap(true, ['title']);
		transport.items['/items/articles/5'] = { id: '5', title: 'Existing', body: 'Body' };

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { body: 'Rewritten' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
	});

	it('clears a target validation error when the target changes', async () => {
		const wrapper = mountDrawer(
			{ collection: 'posts_tags', primaryKey: '+', junctionField: 'tag', relatedPrimaryKey: '+' },
			{ permissions: [create('posts_tags'), create('tags')] }
		);

		await flushPromises();
		invokeSave(wrapper);
		await flushPromises();

		expect((forms(wrapper)[1]!.props('validationErrors') as any[]).length).toBeGreaterThan(0);

		await wrapper.setProps({ collection: 'articles', primaryKey: '+', junctionField: null });
		await flushPromises();

		expect(forms(wrapper)[0]!.props('validationErrors')).toEqual([]);
	});

	it('binds a switched target to its own data even when reads resolve out of order', async () => {
		transport.capabilities['articles/5'] = cap(true);
		transport.capabilities['articles/6'] = cap(true);
		const first = defer('/items/articles/5');
		const second = defer('/items/articles/6');

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { title: 'Only for five' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await wrapper.setProps({ primaryKey: '6', edits: { title: 'Fresh for six' } });

		second.resolve({ data: { data: { id: '6', title: 'Six' } } });
		await flushPromises();
		first.resolve({ data: { data: { id: '5', title: 'Five' } } });
		await flushPromises();

		expect(forms(wrapper)[0]!.props('initialValues')).toMatchObject({ id: '6' });

		await saveButton(wrapper).trigger('click');

		const payload = emittedPayload(wrapper)!;
		expect(payload.id).toBe('6');
		expect(payload.title).toBe('Fresh for six');
	});

	it('does not carry an ordinary seed to a switched key without fresh edits', async () => {
		transport.capabilities['articles/5'] = cap(true);
		transport.capabilities['articles/6'] = cap(true);
		transport.items['/items/articles/5'] = { id: '5', title: 'Five' };
		transport.items['/items/articles/6'] = { id: '6', title: 'Six' };

		const wrapper = mountDrawer(
			{ collection: 'articles', primaryKey: '5', edits: { title: 'Only for five' } },
			{ permissions: [conditionalUpdate('articles')] }
		);

		await flushPromises();
		await wrapper.setProps({ primaryKey: '6' });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect(wrapper.emitted('input')).toBeUndefined();
	});
});

describe('drawer-item m2m two-target gating', () => {
	const m2mProps = {
		collection: 'articles_categories',
		primaryKey: '10',
		junctionField: 'category',
		relatedPrimaryKey: '3',
	};

	function loadM2m() {
		transport.items['/items/articles_categories/10'] = { id: '10', sort: 1 };
		transport.items['/items/categories/3'] = { id: '3', name: 'Cat' };
	}

	it('does not restate an unchanged relationship for a metadata-only junction edit', async () => {
		loadM2m();
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(false, null);

		const wrapper = mountDrawer(
			{ ...m2mProps, edits: { sort: 2, category: { name: 'Renamed' } } },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();

		const [relatedForm, junctionForm] = forms(wrapper);
		expect(relatedForm!.props('disabled')).toBe(true);
		expect(junctionForm!.props('disabled')).toBe(false);

		await saveButton(wrapper).trigger('click');

		const payload = emittedPayload(wrapper)!;
		expect(payload.sort).toBe(2);
		expect(payload.id).toBe('10');
		expect('category' in payload).toBe(false);
	});

	it('emits the related content when both junction and related update are authorized', async () => {
		loadM2m();
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);

		const wrapper = mountDrawer(
			{ ...m2mProps, edits: { category: { name: 'Renamed' } } },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();

		expect(forms(wrapper)[0]!.props('disabled')).toBe(false);

		await saveButton(wrapper).trigger('click');

		expect(emittedPayload(wrapper)?.category).toMatchObject({ name: 'Renamed', id: '3' });
	});

	it('disables related content when the junction cannot write the relation field', async () => {
		loadM2m();
		transport.capabilities['articles_categories/10'] = cap(true, ['sort']);
		transport.capabilities['categories/3'] = cap(true);

		const wrapper = mountDrawer(
			{ ...m2mProps, edits: { category: { name: 'Renamed' } } },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();

		expect(forms(wrapper)[0]!.props('disabled')).toBe(true);
	});

	it('links an existing related item without related update authority and without validating its content', async () => {
		transport.items['/items/categories/3'] = { id: '3', name: 'Cat' };
		transport.capabilities['articles_categories/10'] = cap(true);

		const wrapper = mountDrawer(
			{ collection: 'articles_categories', primaryKey: '+', junctionField: 'category', relatedPrimaryKey: '3' },
			{ permissions: [create('articles_categories')] }
		);

		await flushPromises();
		await saveButton(wrapper).trigger('click');

		const payload = emittedPayload(wrapper)!;
		expect(payload.category).toEqual({ id: '3' });
		expect(forms(wrapper)[0]!.props('validationErrors')).toEqual([]);
	});

	it('includes the nested create object for a mandatory new related record even when empty', async () => {
		const wrapper = mountDrawer(
			{ collection: 'articles_categories', primaryKey: '+', junctionField: 'category', relatedPrimaryKey: '+' },
			{ permissions: [create('articles_categories'), create('categories')] }
		);

		await flushPromises();
		await saveButton(wrapper).trigger('click');

		const payload = emittedPayload(wrapper)!;
		expect('category' in payload).toBe(true);
		expect(payload.category).toEqual({});
	});

	it('cannot stage a partial operation when the mandatory related create is unauthorized', async () => {
		const wrapper = mountDrawer(
			{ collection: 'articles_categories', primaryKey: '+', junctionField: 'category', relatedPrimaryKey: '+' },
			{ permissions: [create('articles_categories')] }
		);

		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();

		await saveButton(wrapper).trigger('click');
		expect(wrapper.emitted('input')).toBeUndefined();
	});

	it('validates the junction operation and routes its error to the junction form', async () => {
		const wrapper = mountDrawer(
			{ collection: 'posts_tags', primaryKey: '+', junctionField: 'tag', relatedPrimaryKey: '+' },
			{ permissions: [create('posts_tags'), create('tags')] }
		);

		await flushPromises();
		await saveButton(wrapper).trigger('click');

		const [relatedForm, junctionForm] = forms(wrapper);
		expect((junctionForm!.props('validationErrors') as any[]).length).toBeGreaterThan(0);
		expect(relatedForm!.props('validationErrors')).toEqual([]);
		expect(wrapper.emitted('input')).toBeUndefined();
	});

	it('does not carry one related target typed edits onto another key after a switch', async () => {
		loadM2m();
		transport.items['/items/categories/4'] = { id: '4', name: 'Four' };
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);
		transport.capabilities['categories/4'] = cap(true);

		const wrapper = mountDrawer(
			{ ...m2mProps },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();

		forms(wrapper)[0]!.vm.$emit('update:modelValue', { name: 'Only for 3' });
		await flushPromises();

		await wrapper.setProps({ relatedPrimaryKey: '4' });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect(wrapper.emitted('input')).toBeUndefined();
	});

	it('emits fresh edits under the switched related key', async () => {
		loadM2m();
		transport.items['/items/categories/4'] = { id: '4', name: 'Four' };
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);
		transport.capabilities['categories/4'] = cap(true);

		const wrapper = mountDrawer(
			{ ...m2mProps },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();

		forms(wrapper)[0]!.vm.$emit('update:modelValue', { name: 'Only for 3' });
		await flushPromises();

		await wrapper.setProps({ relatedPrimaryKey: '4' });
		await flushPromises();

		forms(wrapper)[0]!.vm.$emit('update:modelValue', { name: 'Fresh for 4' });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect(emittedPayload(wrapper)?.category).toMatchObject({ id: '4', name: 'Fresh for 4' });
	});

	it('validates a new related target with its own defaults instead of the previous row', async () => {
		transport.items['/items/docs_authors/10'] = { id: '10', author: { id: '3', name: 'Author' } };
		transport.items['/items/authors/3'] = { id: '3', name: 'Author' };
		transport.capabilities['docs_authors/10'] = cap(true);
		transport.capabilities['authors/3'] = cap(true);

		const wrapper = mountDrawer(
			{ collection: 'docs_authors', primaryKey: '10', junctionField: 'author', relatedPrimaryKey: '3' },
			{ permissions: [conditionalUpdate('docs_authors'), conditionalUpdate('authors'), create('authors')] }
		);

		await flushPromises();

		await wrapper.setProps({ relatedPrimaryKey: '+' });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect((forms(wrapper)[0]!.props('validationErrors') as any[]).length).toBeGreaterThan(0);
		expect(wrapper.emitted('input')).toBeUndefined();
	});

	it('does not mutate the supplied edits object when typing in the related form', async () => {
		loadM2m();
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);

		const seed: Record<string, any> = {};

		const wrapper = mountDrawer(
			{ ...m2mProps, edits: seed },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();

		forms(wrapper)[0]!.vm.$emit('update:modelValue', { name: 'Typed' });
		await flushPromises();

		expect(seed).toEqual({});
	});

	it('does not adopt a previous target seed for a switched related key', async () => {
		loadM2m();
		transport.items['/items/categories/4'] = { id: '4', name: 'Four' };
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);
		transport.capabilities['categories/4'] = cap(true);

		const seed = { category: { name: 'Seeded for three' } };

		const wrapper = mountDrawer(
			{ ...m2mProps, edits: seed },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();
		await wrapper.setProps({ relatedPrimaryKey: '4' });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect(emittedPayload(wrapper)?.category?.name).not.toBe('Seeded for three');
		expect(seed).toEqual({ category: { name: 'Seeded for three' } });
	});

	it('shows a fresh related form when switching to a new related target', async () => {
		loadM2m();
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);

		const wrapper = mountDrawer(
			{ ...m2mProps },
			{ permissions: [conditionalUpdate('articles_categories'), create('categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();
		expect(forms(wrapper)[0]!.props('initialValues')).toMatchObject({ id: '3' });

		await wrapper.setProps({ relatedPrimaryKey: '+' });
		await flushPromises();

		const related = forms(wrapper)[0]!.props('initialValues') as Record<string, any> | undefined;
		expect(related === undefined || 'name' in related === false).toBe(true);
	});

	it('does not carry a seed across a simultaneous main and related switch', async () => {
		loadM2m();
		transport.items['/items/articles_categories/11'] = { id: '11', sort: 0, category: { id: '4' } };
		transport.items['/items/categories/4'] = { id: '4', name: 'Four' };
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['articles_categories/11'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);
		transport.capabilities['categories/4'] = cap(true);

		const seed = { sort: 2, category: { name: 'Only for three' } };

		const wrapper = mountDrawer(
			{ ...m2mProps, edits: seed },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();
		await wrapper.setProps({ primaryKey: '11', relatedPrimaryKey: '4' });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect(wrapper.emitted('input')).toBeUndefined();
	});

	it('keeps an unsaved junction edit when a fresh related seed arrives', async () => {
		loadM2m();
		transport.items['/items/categories/4'] = { id: '4', name: 'Four' };
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);
		transport.capabilities['categories/4'] = cap(true);

		const wrapper = mountDrawer(
			{ ...m2mProps, edits: {} },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();

		forms(wrapper)[1]!.vm.$emit('update:modelValue', { sort: 2 });
		await flushPromises();

		await wrapper.setProps({ relatedPrimaryKey: '4', edits: { category: { name: 'Only for four' } } });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		const payload = emittedPayload(wrapper)!;
		expect(payload.sort).toBe(2);
		expect(payload.category).toMatchObject({ id: '4', name: 'Only for four' });
	});

	it('does not replay a same-target related seed under a later related key', async () => {
		loadM2m();
		transport.items['/items/categories/4'] = { id: '4', name: 'Four' };
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);
		transport.capabilities['categories/4'] = cap(true);

		const wrapper = mountDrawer(
			{ ...m2mProps, edits: {} },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();
		await wrapper.setProps({ edits: { category: { name: 'Only for three' } } });
		await flushPromises();
		await wrapper.setProps({ relatedPrimaryKey: '4' });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect(emittedPayload(wrapper)?.category?.name).not.toBe('Only for three');
	});

	it('does not overwrite a typed related draft when a fresh seed arrives for the same target', async () => {
		loadM2m();
		transport.capabilities['articles_categories/10'] = cap(true);
		transport.capabilities['categories/3'] = cap(true);

		const wrapper = mountDrawer(
			{ ...m2mProps, edits: {} },
			{ permissions: [conditionalUpdate('articles_categories'), conditionalUpdate('categories')] }
		);

		await flushPromises();

		forms(wrapper)[0]!.vm.$emit('update:modelValue', { name: 'Typed' });
		await flushPromises();

		await wrapper.setProps({ edits: { category: { name: 'From seed' } } });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect(emittedPayload(wrapper)?.category).toMatchObject({ name: 'Typed', id: '3' });
	});
});

describe('drawer-item m2a ownership and routing', () => {
	function loadM2a() {
		transport.items['/items/blocks/10'] = { id: '10', sort: 1, collection: 'paragraphs' };
		transport.items['/items/paragraphs/3'] = { id: '3', text: 'Para' };
		transport.items['/items/snippets/3'] = { id: '3', code: 'Snip' };
		transport.capabilities['blocks/10'] = cap(true);
		transport.capabilities['paragraphs/3'] = cap(true);
		transport.capabilities['snippets/3'] = cap(true);
	}

	const m2aPermissions = [conditionalUpdate('blocks'), conditionalUpdate('paragraphs'), conditionalUpdate('snippets')];

	it('mounts an inactive drawer with no discriminator without throwing', async () => {
		expect(() =>
			mountDrawer(
				{
					collection: 'blocks',
					active: false,
					primaryKey: '+',
					junctionField: 'item',
					relatedPrimaryKey: '+',
					edits: {},
				},
				{ permissions: m2aPermissions }
			)
		).not.toThrow();

		await flushPromises();
	});

	it('resolves the discriminator from the stored junction when it is not supplied', async () => {
		loadM2a();

		const wrapper = mountDrawer(
			{ collection: 'blocks', primaryKey: '10', junctionField: 'item', relatedPrimaryKey: '3' },
			{ permissions: m2aPermissions }
		);

		await flushPromises();

		expect(transport.paths).toContain('/items/paragraphs/3');
		expect(forms(wrapper)[0]!.props('initialValues')).toMatchObject({ text: 'Para' });
	});

	it('emits the current discriminator rather than a stale one after a switch', async () => {
		loadM2a();

		const wrapper = mountDrawer(
			{
				collection: 'blocks',
				primaryKey: '10',
				junctionField: 'item',
				relatedPrimaryKey: '3',
				edits: { collection: 'paragraphs' },
			},
			{ permissions: m2aPermissions }
		);

		await flushPromises();
		await wrapper.setProps({ edits: { collection: 'snippets' } });
		await flushPromises();

		forms(wrapper)[0]!.vm.$emit('update:modelValue', { code: 'fresh code' });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		const payload = emittedPayload(wrapper)!;
		expect(payload.collection).toBe('snippets');
		expect(payload.item).toMatchObject({ id: '3', code: 'fresh code' });
	});

	it('refetches related data and drops old data when the discriminator changes', async () => {
		loadM2a();

		const wrapper = mountDrawer(
			{
				collection: 'blocks',
				primaryKey: '10',
				junctionField: 'item',
				relatedPrimaryKey: '3',
				edits: { collection: 'paragraphs' },
			},
			{ permissions: m2aPermissions }
		);

		await flushPromises();
		expect(transport.paths).toContain('/items/paragraphs/3');

		await wrapper.setProps({ edits: { collection: 'snippets' } });
		await flushPromises();

		expect(transport.paths).toContain('/items/snippets/3');
		expect(transport.paths).toContain('/permissions/me/snippets/3');
		expect(forms(wrapper)[0]!.props('initialValues')).toMatchObject({ code: 'Snip' });
		expect('text' in (forms(wrapper)[0]!.props('initialValues') as Record<string, any>)).toBe(false);
	});

	it('does not enable Save for an unchanged row supplying only its discriminator', async () => {
		loadM2a();

		const wrapper = mountDrawer(
			{
				collection: 'blocks',
				primaryKey: '10',
				junctionField: 'item',
				relatedPrimaryKey: '3',
				edits: { collection: 'paragraphs' },
			},
			{ permissions: m2aPermissions }
		);

		await flushPromises();

		expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
	});

	it('keeps a fresh related seed when the replacement discriminator resolves from the read', async () => {
		loadM2a();
		transport.items['/items/blocks/11'] = { id: '11', sort: 0, collection: 'snippets' };
		transport.items['/items/snippets/3'] = { id: '3', code: 'Existing snippet' };
		transport.capabilities['blocks/11'] = cap(true);

		const wrapper = mountDrawer(
			{
				collection: 'blocks',
				primaryKey: '10',
				junctionField: 'item',
				relatedPrimaryKey: '3',
				edits: { collection: 'paragraphs' },
			},
			{ permissions: m2aPermissions }
		);

		await flushPromises();

		await wrapper.setProps({ primaryKey: '11', edits: { item: { code: 'Fresh snippet' } } });
		await flushPromises();

		expect(transport.paths).toContain('/items/snippets/3');
		expect(forms(wrapper)[0]!.props('disabled')).toBe(false);

		invokeSave(wrapper);
		await flushPromises();

		const payload = emittedPayload(wrapper)!;
		expect(payload.collection).toBe('snippets');
		expect(payload.item).toMatchObject({ id: '3', code: 'Fresh snippet' });
	});

	it('keeps a fresh related seed on a replacement that also changes the related key', async () => {
		loadM2a();
		transport.items['/items/blocks/11'] = { id: '11', sort: 0, collection: 'snippets' };
		transport.items['/items/snippets/4'] = { id: '4', code: 'Another snippet' };
		transport.capabilities['blocks/11'] = cap(true);
		transport.capabilities['snippets/4'] = cap(true);

		const wrapper = mountDrawer(
			{
				collection: 'blocks',
				primaryKey: '10',
				junctionField: 'item',
				relatedPrimaryKey: '3',
				edits: { collection: 'paragraphs' },
			},
			{ permissions: m2aPermissions }
		);

		await flushPromises();

		await wrapper.setProps({ primaryKey: '11', relatedPrimaryKey: '4', edits: { item: { code: 'Fresh snippet' } } });
		await flushPromises();

		expect(transport.paths).toContain('/items/snippets/4');
		expect(forms(wrapper)[0]!.props('disabled')).toBe(false);

		invokeSave(wrapper);
		await flushPromises();

		const payload = emittedPayload(wrapper)!;
		expect(payload.collection).toBe('snippets');
		expect(payload.item).toMatchObject({ id: '4', code: 'Fresh snippet' });
	});

	it('discards a pending related seed when its target is superseded before resolution', async () => {
		loadM2a();
		transport.items['/items/blocks/12'] = { id: '12', sort: 0, collection: 'snippets' };
		transport.items['/items/snippets/4'] = { id: '4', code: 'Snippet four' };
		transport.capabilities['blocks/11'] = cap(true);
		transport.capabilities['blocks/12'] = cap(true);
		transport.capabilities['snippets/4'] = cap(true);

		const blocksEleven = defer('/items/blocks/11');

		const wrapper = mountDrawer(
			{
				collection: 'blocks',
				primaryKey: '10',
				junctionField: 'item',
				relatedPrimaryKey: '3',
				edits: { collection: 'paragraphs' },
			},
			{ permissions: m2aPermissions }
		);

		await flushPromises();

		await wrapper.setProps({ primaryKey: '11', edits: { item: { code: 'Only for junction eleven' } } });
		await wrapper.setProps({ primaryKey: '12', relatedPrimaryKey: '4' });
		await flushPromises();

		blocksEleven.resolve({ data: { data: { id: '11', sort: 0, collection: 'snippets' } } });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect(emittedPayload(wrapper)?.item?.code).not.toBe('Only for junction eleven');
	});

	it('adopts a fresh explicit related collection selected during a pending resolution', async () => {
		transport.items['/items/blocks/10'] = { id: '10', sort: 1, collection: 'paragraphs' };
		transport.items['/items/paragraphs/3'] = { id: '3', title: 'Paragraph existing' };
		transport.items['/items/snippets/3'] = { id: '3', title: 'Snippet existing' };
		transport.capabilities['blocks/10'] = cap(true);
		transport.capabilities['paragraphs/3'] = cap(true);
		transport.capabilities['snippets/3'] = cap(true);

		const blocksTen = defer('/items/blocks/10');

		const wrapper = mountDrawer(
			{
				collection: 'blocks',
				primaryKey: '10',
				junctionField: 'item',
				relatedPrimaryKey: '3',
				edits: { item: { title: 'Paragraph draft' } },
			},
			{ permissions: m2aPermissions }
		);

		await wrapper.setProps({ edits: { collection: 'snippets', item: { title: 'Snippet draft' } } });
		await flushPromises();

		blocksTen.resolve({ data: { data: { id: '10', sort: 1, collection: 'paragraphs' } } });
		await flushPromises();

		expect(forms(wrapper)[0]!.props('disabled')).toBe(false);

		invokeSave(wrapper);
		await flushPromises();

		const payload = emittedPayload(wrapper)!;
		expect(payload.collection).toBe('snippets');
		expect(payload.item).toMatchObject({ id: '3', title: 'Snippet draft' });
	});

	it('discards a superseded draft when a fresh explicit collection carries no content', async () => {
		transport.items['/items/blocks/10'] = { id: '10', sort: 1, collection: 'paragraphs' };
		transport.items['/items/paragraphs/3'] = { id: '3', title: 'Paragraph existing' };
		transport.items['/items/snippets/3'] = { id: '3', title: 'Snippet existing' };
		transport.capabilities['blocks/10'] = cap(true);
		transport.capabilities['paragraphs/3'] = cap(true);
		transport.capabilities['snippets/3'] = cap(true);

		const blocksTen = defer('/items/blocks/10');

		const wrapper = mountDrawer(
			{
				collection: 'blocks',
				primaryKey: '10',
				junctionField: 'item',
				relatedPrimaryKey: '3',
				edits: { item: { title: 'Paragraph draft' } },
			},
			{ permissions: m2aPermissions }
		);

		await wrapper.setProps({ edits: { collection: 'snippets' } });
		await flushPromises();

		blocksTen.resolve({ data: { data: { id: '10', sort: 1, collection: 'paragraphs' } } });
		await flushPromises();

		invokeSave(wrapper);
		await flushPromises();

		expect(emittedPayload(wrapper)?.item?.title).not.toBe('Paragraph draft');
	});
});
