import api from '@/api';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { ItemPermissions, Permission } from '@cairncms/types';
import { Ref, ref, unref, watch } from 'vue';

type ItemAction = 'update' | 'delete' | 'share';

function isUnconditional(permission: Permission): boolean {
	return !permission.permissions || Object.keys(permission.permissions).length === 0;
}

// Conditional filters are evaluated by the server; a missing result remains denied.
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
