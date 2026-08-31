import { createTestingPinia } from '@pinia/testing';
import { flushPromises } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { me } = vi.hoisted(() => ({ me: { paths: [] as string[], reject: false, response: null as any } }));

beforeEach(() => {
	setActivePinia(
		createTestingPinia({
			createSpy: vi.fn,
			stubActions: false,
		})
	);

	me.paths = [];
	me.reject = false;
	me.response = null;
});

import { useUserStore } from '@/stores/user';
import { usePermissionsStore } from '@/stores/permissions';
import { usePermissions } from './use-permissions';
import { useCollection } from '@cairncms/composables';
import { Field } from '@cairncms/types';

vi.mock('@cairncms/composables');

const mockReadPermissions = {
	role: '00000000-0000-0000-0000-000000000000',
	permissions: {
		_and: [{ field_a: { _null: true } }, { field_b: { _null: true } }],
	},
	validation: null,
	presets: null,
	fields: ['id', 'start_date', 'end_date'],
	collection: 'test',
	action: 'read',
};

const mockFields: Field[] = [
	{ collection: 'test', field: 'id', name: 'id', type: 'integer', schema: null, meta: null },
	{ collection: 'test', field: 'name', name: 'name', type: 'string', schema: null, meta: null },
	{ collection: 'test', field: 'start_date', name: 'start_date', type: 'timestamp', schema: null, meta: null },
	{ collection: 'test', field: 'end_date', name: 'end_date', type: 'timestamp', schema: null, meta: null },
];

vi.mock('@/api', () => {
	return {
		default: {
			get: (path: string) => {
				if (path === '/permissions') {
					return Promise.resolve({ data: { data: [mockReadPermissions] } });
				}

				if (path.startsWith('/permissions/me/')) {
					me.paths.push(path);
					if (me.reject) return Promise.reject(new Error('fail'));
					return Promise.resolve({ data: { data: me.response } });
				}

				return Promise.reject(new Error(`GET "${path}" is not mocked in this test`));
			},
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('usePermissions item actions', () => {
	function mockCollection(options: { archiveField?: string; singleton?: boolean } = {}) {
		vi.mocked(useCollection).mockReturnValue({
			info: ref({
				meta: {
					...(options.archiveField ? { archive_field: options.archiveField, archive_value: 'archived' } : {}),
					...(options.singleton ? { singleton: true } : {}),
				},
			}),
			fields: ref(mockFields),
			primaryKeyField: ref({ field: 'id' }),
		} as any);
	}

	function setup(options: {
		admin?: boolean;
		permissions?: any[];
		item?: any;
		requestedKey?: string | number | null;
		loading?: boolean;
		error?: unknown;
		isNew?: boolean;
		archiveField?: string;
		singleton?: boolean;
	}) {
		(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: options.admin ?? false } };
		(usePermissionsStore() as any).permissions = options.permissions ?? [];
		mockCollection({ archiveField: options.archiveField, singleton: options.singleton });

		return usePermissions(ref('test'), ref(options.item ?? null), ref(options.isNew ?? false), {
			primaryKey: ref(options.requestedKey ?? null),
			loading: ref(options.loading ?? false),
			error: ref(options.error ?? null),
		});
	}

	function updatePermission(filter: Record<string, any> | null, fields: string[]) {
		return { collection: 'test', action: 'update', role: 'role-1', permissions: filter, fields };
	}

	test('allows an admin on a loaded item whose key matches the request', () => {
		const { updateAllowed } = setup({ admin: true, item: { id: '5' }, requestedKey: '5' });

		expect(updateAllowed.value).toBe(true);
	});

	test('denies item actions while the item is loading, even for an admin', () => {
		const { updateAllowed } = setup({ admin: true, item: { id: '5' }, requestedKey: '5', loading: true });

		expect(updateAllowed.value).toBe(false);
	});

	test('denies item actions during pending navigation when the retained item is a different record', () => {
		const { updateAllowed } = setup({ admin: true, item: { id: 'A' }, requestedKey: 'B', loading: true });

		expect(updateAllowed.value).toBe(false);
	});

	test('denies item actions after a failed load leaves the previous record retained', () => {
		const { updateAllowed } = setup({ admin: true, item: { id: 'A' }, requestedKey: 'B', error: new Error('nope') });

		expect(updateAllowed.value).toBe(false);
	});

	test('denies item actions when the retained key does not match the request', () => {
		const { updateAllowed } = setup({ admin: true, item: { id: 'A' }, requestedKey: 'B' });

		expect(updateAllowed.value).toBe(false);
	});

	test('treats a numeric zero key as a match against the string route key', () => {
		const { updateAllowed } = setup({ admin: true, item: { id: 0 }, requestedKey: '0' });

		expect(updateAllowed.value).toBe(true);
	});

	test('readies a singleton after a successful load despite a null route key', () => {
		const { updateAllowed } = setup({ admin: true, item: { id: 1 }, requestedKey: null, singleton: true });

		expect(updateAllowed.value).toBe(true);
	});

	test('keeps a singleton unavailable while loading', () => {
		const { updateAllowed } = setup({
			admin: true,
			item: { id: 1 },
			requestedKey: null,
			singleton: true,
			loading: true,
		});

		expect(updateAllowed.value).toBe(false);
	});

	test('keeps a singleton unavailable after a failed load', () => {
		const { updateAllowed } = setup({
			admin: true,
			item: { id: 1 },
			requestedKey: null,
			singleton: true,
			error: new Error('nope'),
		});

		expect(updateAllowed.value).toBe(false);
	});

	test('resolves an unconditional fast path without an item-permissions request', async () => {
		const { updateAllowed } = setup({
			admin: false,
			permissions: [updatePermission(null, ['*'])],
			item: { id: '5' },
			requestedKey: '5',
		});

		await flushPromises();

		expect(updateAllowed.value).toBe(true);
		expect(me.paths).toEqual([]);
	});

	test('grants a conditional update through the server capability result', async () => {
		me.response = { update: { access: true, fields: ['*'] }, delete: { access: false }, share: { access: false } };

		const { updateAllowed } = setup({
			admin: false,
			permissions: [updatePermission({ status: { _eq: 'x' } }, ['*'])],
			item: { id: '5' },
			requestedKey: '5',
		});

		await flushPromises();

		expect(me.paths).toEqual(['/permissions/me/test/5']);
		expect(updateAllowed.value).toBe(true);
	});

	test('denies a conditional update when the server capabilities are unavailable', async () => {
		me.reject = true;

		const { updateAllowed } = setup({
			admin: false,
			permissions: [updatePermission({ status: { _eq: 'x' } }, ['*'])],
			item: { id: '5' },
			requestedKey: '5',
		});

		await flushPromises();

		expect(updateAllowed.value).toBe(false);
	});

	test('shows the create affordance for a conditional create permission', () => {
		const { createAllowed } = setup({
			admin: false,
			permissions: [{ collection: 'test', action: 'create', role: 'role-1', permissions: { status: { _eq: 'x' } } }],
			item: null,
			isNew: true,
		});

		expect(createAllowed.value).toBe(true);
	});

	test('allows archive for an admin when the collection has an archive field', () => {
		const { archiveAllowed } = setup({ admin: true, item: { id: '5' }, requestedKey: '5', archiveField: 'status' });

		expect(archiveAllowed.value).toBe(true);
	});

	test('denies archive when the archive field is not editable', () => {
		const { archiveAllowed } = setup({
			admin: false,
			permissions: [updatePermission(null, ['title'])],
			item: { id: '5' },
			requestedKey: '5',
			archiveField: 'status',
		});

		expect(archiveAllowed.value).toBe(false);
	});

	test('allows archive when the archive field is editable', () => {
		const { archiveAllowed } = setup({
			admin: false,
			permissions: [updatePermission(null, ['status'])],
			item: { id: '5' },
			requestedKey: '5',
			archiveField: 'status',
		});

		expect(archiveAllowed.value).toBe(true);
	});

	test('issues a single capability request across a loading-to-ready transition', async () => {
		me.response = { update: { access: true, fields: ['*'] }, delete: { access: false }, share: { access: false } };
		(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: false } };
		(usePermissionsStore() as any).permissions = [updatePermission({ status: { _eq: 'x' } }, ['*'])];
		mockCollection();

		const item = ref<any>(null);
		const loading = ref(true);
		const primaryKey = ref<string | null>('5');
		const error = ref<unknown>(null);

		usePermissions(ref('test'), item, ref(false), { primaryKey, loading, error });
		await flushPromises();

		expect(me.paths).toEqual([]);

		item.value = { id: '5' };
		loading.value = false;
		await flushPromises();

		expect(me.paths).toEqual(['/permissions/me/test/5']);
	});

	test('refetches once when the item is replaced with the same key (a save)', async () => {
		me.response = { update: { access: true, fields: ['*'] }, delete: { access: false }, share: { access: false } };
		(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: false } };
		(usePermissionsStore() as any).permissions = [updatePermission({ status: { _eq: 'x' } }, ['*'])];
		mockCollection();

		const item = ref<any>({ id: '5' });
		const loading = ref(false);
		const primaryKey = ref<string | null>('5');
		const error = ref<unknown>(null);

		usePermissions(ref('test'), item, ref(false), { primaryKey, loading, error });
		await flushPromises();

		expect(me.paths).toEqual(['/permissions/me/test/5']);

		item.value = { id: '5', modified: true };
		await flushPromises();

		expect(me.paths).toEqual(['/permissions/me/test/5', '/permissions/me/test/5']);
	});

	test('resolves an admin without an item-permissions request', async () => {
		const { updateAllowed } = setup({ admin: true, item: { id: '5' }, requestedKey: '5' });
		await flushPromises();

		expect(updateAllowed.value).toBe(true);
		expect(me.paths).toEqual([]);
	});
});
