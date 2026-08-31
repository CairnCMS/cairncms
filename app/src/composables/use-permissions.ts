import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { Field, Permission } from '@cairncms/types';
import { computed, ComputedRef, Ref } from 'vue';
import { useFieldPermissions } from './use-field-permissions';
import { hasConditionalItemPermission, itemActionAllowed, useItemPermissions } from './use-item-permissions';
import { useCollection } from '@cairncms/composables';

type UsablePermissions = {
	createAllowed: ComputedRef<boolean>;
	deleteAllowed: ComputedRef<boolean>;
	saveAllowed: ComputedRef<boolean>;
	archiveAllowed: ComputedRef<boolean>;
	updateAllowed: ComputedRef<boolean>;
	shareAllowed: ComputedRef<boolean>;
	fields: ComputedRef<Field[]>;
	revisionsAllowed: ComputedRef<boolean>;
};

type ItemContext = {
	primaryKey: Ref<string | number | null>;
	loading: Ref<boolean>;
	error: Ref<unknown>;
};

export function usePermissions(
	collection: Ref<string>,
	item: Ref<any>,
	isNew: Ref<boolean>,
	context: ItemContext
): UsablePermissions {
	const userStore = useUserStore();
	const permissionsStore = usePermissionsStore();

	const { info: collectionInfo, primaryKeyField } = useCollection(collection);

	const { fields } = useFieldPermissions(collection, isNew);

	const isAdmin = computed(() => userStore.currentUser?.role?.admin_access === true);

	const loadedKey = computed<string | number | null>(() => {
		const keyField = primaryKeyField.value?.field;
		if (!keyField) return null;

		return item.value?.[keyField] ?? null;
	});

	const itemReady = computed(() => {
		if (isNew.value) return false;
		if (context.loading.value === true) return false;
		if (context.error.value != null) return false;
		if (item.value == null || loadedKey.value === null) return false;

		const requested = context.primaryKey.value ?? null;

		if (collectionInfo.value?.meta?.singleton === true) return requested === null;

		if (requested === null) return false;

		return String(loadedKey.value) === String(requested);
	});

	const needsServerCheck = computed(
		() => itemReady.value && hasConditionalItemPermission(collection.value, ['update', 'delete', 'share'])
	);

	const primaryKey = computed<string | number | null>(() => (itemReady.value ? loadedKey.value : null));

	const { itemPermissions } = useItemPermissions(collection, primaryKey, needsServerCheck, item);

	function isUnconditional(permission: Permission): boolean {
		return !permission.permissions || Object.keys(permission.permissions).length === 0;
	}

	function fieldEditable(fields: string[] | null | undefined, field: string): boolean {
		if (!fields || fields.length === 0) return false;
		return fields.includes('*') || fields.includes(field);
	}

	const createAllowed = computed(() => {
		if (isAdmin.value) return true;
		return !!permissionsStore.getPermissionsForUser(collection.value, 'create');
	});

	const deleteAllowed = computed(() =>
		itemActionAllowed(collection.value, 'delete', itemPermissions.value, itemReady.value)
	);

	const saveAllowed = computed(() => {
		if (isNew.value) return true;
		return itemActionAllowed(collection.value, 'update', itemPermissions.value, itemReady.value);
	});

	const updateAllowed = computed(() =>
		itemActionAllowed(collection.value, 'update', itemPermissions.value, itemReady.value)
	);

	const shareAllowed = computed(() =>
		itemActionAllowed(collection.value, 'share', itemPermissions.value, itemReady.value)
	);

	const archiveAllowed = computed(() => {
		const archiveField = collectionInfo.value?.meta?.archive_field;
		if (!archiveField) return false;
		if (!itemReady.value) return false;
		if (isAdmin.value) return true;

		const permission = permissionsStore.getPermissionsForUser(collection.value, 'update');
		if (!permission) return false;

		if (isUnconditional(permission)) {
			return fieldEditable(permission.fields, archiveField);
		}

		if (itemPermissions.value?.update.access !== true) return false;
		return fieldEditable(itemPermissions.value.update.fields, archiveField);
	});

	const revisionsAllowed = computed(() => {
		if (userStore.currentUser?.role?.admin_access === true) return true;
		return !!permissionsStore.permissions.find(
			(permission) => permission.collection === 'directus_revisions' && permission.action === 'read'
		);
	});

	return {
		createAllowed,
		deleteAllowed,
		saveAllowed,
		archiveAllowed,
		updateAllowed,
		shareAllowed,
		fields,
		revisionsAllowed,
	};
}
