import api from '@/api';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { ItemPermissions, Permission } from '@cairncms/types';
import { Ref, computed, ref, unref, watch } from 'vue';

type ItemAction = 'update' | 'delete' | 'share';

function isUnconditional(permission: Permission): boolean {
	return !permission.permissions || Object.keys(permission.permissions).length === 0;
}

// Only the server evaluates conditional filters. Missing results remain denied.
export function itemActionAllowed(
	collection: string,
	action: ItemAction,
	itemPermissions: ItemPermissions | null,
	localReady: boolean,
	capabilityReady: boolean
): boolean {
	if (!localReady) return false;

	const userStore = useUserStore();
	const permissionsStore = usePermissionsStore();

	if (userStore.currentUser?.role?.admin_access === true) return true;

	const permission = permissionsStore.getPermissionsForUser(collection, action);
	if (!permission) return false;
	if (isUnconditional(permission)) return true;

	if (!capabilityReady) return false;

	return itemPermissions?.[action].access === true;
}

export function hasConditionalItemPermission(collection: string, actions: ItemAction[]): boolean {
	const userStore = useUserStore();
	const permissionsStore = usePermissionsStore();

	if (userStore.currentUser?.role?.admin_access === true) return false;

	return actions.some((action) => {
		const permission = permissionsStore.getPermissionsForUser(collection, action);
		return !!permission && !isUnconditional(permission);
	});
}

export function useItemPermissions(
	collection: Ref<string>,
	primaryKey: Ref<string | number | null>,
	enabled: Ref<boolean>,
	itemSource: Ref<unknown>
) {
	const itemPermissions = ref<ItemPermissions | null>(null);
	const loading = ref(false);
	const error = ref<unknown>(null);

	let generation = 0;

	watch([collection, primaryKey, enabled, () => itemSource.value], () => refresh(), { immediate: true });

	return { itemPermissions, loading, error, refresh };

	async function refresh() {
		const token = ++generation;
		const key = unref(primaryKey);
		const collectionName = unref(collection);

		itemPermissions.value = null;
		error.value = null;

		if (unref(enabled) !== true || key === null || key === undefined || !collectionName) {
			loading.value = false;
			return;
		}

		loading.value = true;

		try {
			const response = await api.get(
				`/permissions/me/${encodeURIComponent(collectionName)}/${encodeURIComponent(String(key))}`
			);

			if (token !== generation) return;

			itemPermissions.value = response.data.data as ItemPermissions;
		} catch (fetchError) {
			if (token !== generation) return;

			error.value = fetchError;
			itemPermissions.value = null;
		} finally {
			if (token === generation) loading.value = false;
		}
	}
}

function hasKey(key: string | number | null | undefined): key is string | number {
	return key !== null && key !== undefined;
}

export function useItemUpdateGate(options: {
	collection: Ref<string>;
	primaryKey: Ref<string | number | null>;
	enabled: Ref<boolean>;
	localReady: Ref<boolean>;
	itemSource: Ref<unknown>;
}) {
	const { collection, primaryKey, enabled, localReady, itemSource } = options;

	const conditionalUpdate = computed(
		() =>
			enabled.value === true &&
			hasKey(primaryKey.value) &&
			!!collection.value &&
			hasConditionalItemPermission(collection.value, ['update'])
	);

	const { itemPermissions } = useItemPermissions(collection, primaryKey, conditionalUpdate, itemSource);

	const capabilityReady = computed(() => conditionalUpdate.value === false || itemPermissions.value !== null);

	const updateAllowed = computed(() => {
		if (!hasKey(primaryKey.value) || !collection.value) return false;
		return itemActionAllowed(
			collection.value,
			'update',
			itemPermissions.value,
			localReady.value,
			capabilityReady.value
		);
	});

	const writableFields = computed<string[] | null>(() => {
		if (!collection.value) return null;

		const userStore = useUserStore();
		if (userStore.currentUser?.role?.admin_access === true) return ['*'];

		const permissionsStore = usePermissionsStore();
		const permission = permissionsStore.getPermissionsForUser(collection.value, 'update');
		if (!permission) return null;
		if (isUnconditional(permission)) return permission.fields ?? null;

		return itemPermissions.value?.update.fields ?? null;
	});

	function fieldWritable(name: string): boolean {
		if (updateAllowed.value === false) return false;
		const fields = writableFields.value;
		return !!fields && (fields.includes('*') || fields.includes(name));
	}

	return { updateAllowed, writableFields, fieldWritable };
}
