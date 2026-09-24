import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
	hasConditionalItemPermission,
	itemActionAllowed,
	useItemPermissions,
	useItemUpdateGate,
} from './use-item-permissions';

const apiGet = vi.fn();

vi.mock('@/api', () => ({ default: { get: (...args: any[]) => apiGet(...args) } }));

const allowed = {
	update: { access: true, fields: ['title'] },
	delete: { access: false },
	share: { access: false },
};

const denied = {
	update: { access: false, fields: null },
	delete: { access: false },
	share: { access: false },
};

function setUser(admin: boolean) {
	(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: admin } };
}

function permission(action: string, filter: Record<string, any> | null) {
	return { collection: 'articles', action, role: 'role-1', permissions: filter };
}

function setPermissions(permissions: any[]) {
	(usePermissionsStore() as any).permissions = permissions;
}

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
	apiGet.mockReset();
});

describe('itemActionAllowed', () => {
	it('is unavailable when the item is not ready, even for an admin', () => {
		setUser(true);
		setPermissions([]);

		expect(itemActionAllowed('articles', 'update', null, false, false)).toBe(false);
	});

	it('allows any action for an admin once the item is ready', () => {
		setUser(true);
		setPermissions([]);

		expect(itemActionAllowed('articles', 'update', null, true, true)).toBe(true);
	});

	it('denies when there is no matching permission', () => {
		setUser(false);
		setPermissions([]);

		expect(itemActionAllowed('articles', 'update', null, true, true)).toBe(false);
	});

	it('allows an unconditional permission without the server result', () => {
		setUser(false);
		setPermissions([permission('update', null)]);

		expect(itemActionAllowed('articles', 'update', null, true, true)).toBe(true);
	});

	it('defers a conditional permission to the server access result', () => {
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		expect(itemActionAllowed('articles', 'update', allowed, true, true)).toBe(true);
		expect(itemActionAllowed('articles', 'update', denied, true, true)).toBe(false);
	});

	it('is unavailable for a conditional permission when the server result is missing', () => {
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'x' } })]);

		expect(itemActionAllowed('articles', 'update', null, true, true)).toBe(false);
	});

	it('fails a conditional permission closed when locally ready but not capability ready', () => {
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		expect(itemActionAllowed('articles', 'update', allowed, true, false)).toBe(false);
	});

	it('allows an unconditional permission when locally ready without capability readiness', () => {
		setUser(false);
		setPermissions([permission('update', null)]);

		expect(itemActionAllowed('articles', 'update', null, true, false)).toBe(true);
	});
});

describe('hasConditionalItemPermission', () => {
	it('is false for an admin', () => {
		setUser(true);
		setPermissions([]);

		expect(hasConditionalItemPermission('articles', ['update', 'delete', 'share'])).toBe(false);
	});

	it('is false with no matching permission or only unconditional ones', () => {
		setUser(false);
		setPermissions([permission('update', null)]);

		expect(hasConditionalItemPermission('articles', ['update', 'delete', 'share'])).toBe(false);
	});

	it('is true when any action has a conditional permission', () => {
		setUser(false);
		setPermissions([permission('delete', { owner: { _eq: '$CURRENT_USER' } })]);

		expect(hasConditionalItemPermission('articles', ['update', 'delete', 'share'])).toBe(true);
	});
});

describe('useItemPermissions', () => {
	it('does not fetch when disabled', async () => {
		const { itemPermissions } = useItemPermissions(ref('articles'), ref('5'), ref(false), ref(null));
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(itemPermissions.value).toBeNull();
	});

	it('fetches when enabled with a key', async () => {
		apiGet.mockResolvedValue({ data: { data: allowed } });

		const { itemPermissions } = useItemPermissions(ref('articles'), ref('5'), ref(true), ref(null));
		await flushPromises();

		expect(apiGet).toHaveBeenCalledWith('/permissions/me/articles/5');
		expect(itemPermissions.value).toEqual(allowed);
	});

	it('does not fetch when the key is null', async () => {
		const { itemPermissions } = useItemPermissions(ref('articles'), ref(null), ref(true), ref(null));
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(itemPermissions.value).toBeNull();
	});

	it('leaves the result null on a request failure', async () => {
		apiGet.mockRejectedValue(new Error('network'));

		const { itemPermissions } = useItemPermissions(ref('articles'), ref('5'), ref(true), ref(null));
		await flushPromises();

		expect(itemPermissions.value).toBeNull();
	});

	it('refetches when refresh is called for the same key', async () => {
		apiGet.mockResolvedValue({ data: { data: allowed } });

		const { refresh } = useItemPermissions(ref('articles'), ref('5'), ref(true), ref(null));
		await flushPromises();

		expect(apiGet).toHaveBeenCalledTimes(1);

		await refresh();

		expect(apiGet).toHaveBeenCalledTimes(2);
	});

	it('refetches when the source identity changes for the same key', async () => {
		apiGet.mockResolvedValue({ data: { data: allowed } });

		const source = ref<any>({ id: '5' });
		useItemPermissions(ref('articles'), ref('5'), ref(true), source);
		await flushPromises();

		expect(apiGet).toHaveBeenCalledTimes(1);

		source.value = { id: '5', modified: true };
		await flushPromises();

		expect(apiGet).toHaveBeenCalledTimes(2);
	});

	it('ignores a superseded response when the key changes mid-flight', async () => {
		let resolveFirst: () => void = () => undefined;
		let resolveSecond: () => void = () => undefined;

		apiGet
			.mockImplementationOnce(
				() => new Promise((resolve) => (resolveFirst = () => resolve({ data: { data: allowed } })))
			)
			.mockImplementationOnce(
				() => new Promise((resolve) => (resolveSecond = () => resolve({ data: { data: denied } })))
			);

		const key = ref<string | null>('A');
		const { itemPermissions } = useItemPermissions(ref('articles'), key, ref(true), ref(null));
		await flushPromises();

		key.value = 'B';
		await flushPromises();

		resolveSecond();
		await flushPromises();

		resolveFirst();
		await flushPromises();

		expect(itemPermissions.value).toEqual(denied);
	});
});

const allowedEmpty = {
	update: { access: true, fields: [] as string[] },
	delete: { access: false },
	share: { access: false },
};

function gate(
	overrides: {
		collection?: string;
		primaryKey?: string | number | null;
		enabled?: boolean;
		localReady?: boolean;
	} = {}
) {
	return useItemUpdateGate({
		collection: ref(overrides.collection ?? 'articles'),
		primaryKey: ref<string | number | null>('primaryKey' in overrides ? overrides.primaryKey ?? null : '5'),
		enabled: ref(overrides.enabled ?? true),
		localReady: ref(overrides.localReady ?? true),
		itemSource: ref(null),
	});
}

describe('useItemUpdateGate', () => {
	it('allows an admin without fetching and treats every field as writable', async () => {
		setUser(true);
		setPermissions([]);

		const { updateAllowed, writableFields, fieldWritable } = gate();
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(updateAllowed.value).toBe(true);
		expect(writableFields.value).toEqual(['*']);
		expect(fieldWritable('title')).toBe(true);
	});

	it('allows an unconditional grant without fetching and gates on its fields', async () => {
		setUser(false);
		setPermissions([{ ...permission('update', null), fields: ['title'] }]);

		const { updateAllowed, writableFields, fieldWritable } = gate();
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(updateAllowed.value).toBe(true);
		expect(writableFields.value).toEqual(['title']);
		expect(fieldWritable('title')).toBe(true);
		expect(fieldWritable('body')).toBe(false);
	});

	it('denies when there is no matching permission', async () => {
		setUser(false);
		setPermissions([]);

		const { updateAllowed, writableFields, fieldWritable } = gate();
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(updateAllowed.value).toBe(false);
		expect(writableFields.value).toBeNull();
		expect(fieldWritable('title')).toBe(false);
	});

	it('defers a conditional grant to the server result', async () => {
		apiGet.mockResolvedValue({ data: { data: allowed } });
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		const { updateAllowed, writableFields } = gate();

		expect(updateAllowed.value).toBe(false);

		await flushPromises();

		expect(apiGet).toHaveBeenCalledWith('/permissions/me/articles/5');
		expect(updateAllowed.value).toBe(true);
		expect(writableFields.value).toEqual(['title']);
	});

	it('denies a conditional grant the server rejects', async () => {
		apiGet.mockResolvedValue({ data: { data: denied } });
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		const { updateAllowed } = gate();
		await flushPromises();

		expect(updateAllowed.value).toBe(false);
	});

	it('stays unavailable when the capability request fails', async () => {
		apiGet.mockRejectedValue(new Error('network'));
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		const { updateAllowed, fieldWritable } = gate();
		await flushPromises();

		expect(updateAllowed.value).toBe(false);
		expect(fieldWritable('title')).toBe(false);
	});

	it('grants row access but no writable field for access true with empty fields', async () => {
		apiGet.mockResolvedValue({ data: { data: allowedEmpty } });
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		const { updateAllowed, writableFields, fieldWritable } = gate();
		await flushPromises();

		expect(updateAllowed.value).toBe(true);
		expect(writableFields.value).toEqual([]);
		expect(fieldWritable('title')).toBe(false);
	});

	it('does not fetch when disabled, even for a conditional grant', async () => {
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		const { updateAllowed } = gate({ enabled: false });
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(updateAllowed.value).toBe(false);
	});

	it('disables the whole path for a null key, including an admin', async () => {
		setUser(true);
		setPermissions([]);

		const { updateAllowed } = gate({ primaryKey: null });
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(updateAllowed.value).toBe(false);
	});

	it('treats a numeric zero key as a valid target', async () => {
		apiGet.mockResolvedValue({ data: { data: allowed } });
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		const { updateAllowed } = gate({ primaryKey: 0 });
		await flushPromises();

		expect(apiGet).toHaveBeenCalledWith('/permissions/me/articles/0');
		expect(updateAllowed.value).toBe(true);
	});

	it('is unavailable and does not fetch for an empty collection', async () => {
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		const { updateAllowed, writableFields } = gate({ collection: '' });
		await flushPromises();

		expect(apiGet).not.toHaveBeenCalled();
		expect(updateAllowed.value).toBe(false);
		expect(writableFields.value).toBeNull();
	});

	it('fetches on enabled while the allow decision still waits on local readiness', async () => {
		apiGet.mockResolvedValue({ data: { data: allowed } });
		setUser(false);
		setPermissions([permission('update', { status: { _eq: 'published' } })]);

		const collection = ref('articles');
		const primaryKey = ref<string | number | null>('5');
		const enabled = ref(true);
		const localReady = ref(false);

		const { updateAllowed } = useItemUpdateGate({ collection, primaryKey, enabled, localReady, itemSource: ref(null) });
		await flushPromises();

		expect(apiGet).toHaveBeenCalledWith('/permissions/me/articles/5');
		expect(updateAllowed.value).toBe(false);

		localReady.value = true;
		await flushPromises();

		expect(updateAllowed.value).toBe(true);
	});
});
