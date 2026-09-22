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
	isNewOrEmptySingleton: Ref<boolean>;
	isBatch: Ref<boolean>;
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

	const { fields } = useFieldPermissions(collection, context.isNewOrEmptySingleton);

	const isAdmin = computed(() => userStore.currentUser?.role?.admin_access === true);

	const loadedKey = computed<string | number | null>(() => {
		const keyField = primaryKeyField.value?.field;
		if (!keyField) return null;

		return item.value?.[keyField] ?? null;
	});

	const isSingleton = computed(() => collectionInfo.value?.meta?.singleton === true);
	const isEmptySingleton = computed(() => context.isNewOrEmptySingleton.value && isNew.value === false);

	const loadCurrent = computed(() => {
		if (isNew.value) return false;
		if (context.loading.value === true) return false;
		if (context.error.value != null) return false;
		return item.value != null;
	});

	const capabilityReady = computed(() => {
		if (loadCurrent.value === false) return false;
		if (context.isBatch.value === true) return false;
		if (isEmptySingleton.value === true) return false;
		if (loadedKey.value === null) return false;

		const requested = context.primaryKey.value ?? null;

		if (isSingleton.value === true) return requested === null;

		if (requested === null) return false;

		return String(loadedKey.value) === String(requested);
	});

	const localReady = computed(() => {
		if (loadCurrent.value === false) return false;
		if (isEmptySingleton.value === true) return false;
		if (context.isBatch.value === true) return true;

		return capabilityReady.value;
	});

	const needsServerCheck = computed(
		() => capabilityReady.value && hasConditionalItemPermission(collection.value, ['update', 'delete', 'share'])
	);

	const primaryKey = computed<string | number | null>(() => (capabilityReady.value ? loadedKey.value : null));

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

	const deleteAllowed = computed(() => {
		if (context.isBatch.value === true) {
			if (localReady.value === false) return false;
			return permissionsStore.hasPermission(collection.value, 'delete');
		}

		return itemActionAllowed(
			collection.value,
			'delete',
			itemPermissions.value,
			localReady.value,
			capabilityReady.value
		);
	});

	const updateAllowed = computed(() => {
		if (isEmptySingleton.value) return createAllowed.value;

		if (context.isBatch.value === true) {
			if (localReady.value === false) return false;
			return permissionsStore.hasPermission(collection.value, 'update');
		}

		return itemActionAllowed(
			collection.value,
			'update',
			itemPermissions.value,
			localReady.value,
			capabilityReady.value
		);
	});

	const saveAllowed = computed(() => {
		if (isNew.value) return true;
		return updateAllowed.value;
	});

	const shareAllowed = computed(() =>
		itemActionAllowed(collection.value, 'share', itemPermissions.value, localReady.value, capabilityReady.value)
	);

	const archiveAllowed = computed(() => {
		const archiveField = collectionInfo.value?.meta?.archive_field;
		if (!archiveField) return false;
		if (localReady.value === false) return false;
		if (isAdmin.value) return true;

		const permission = permissionsStore.getPermissionsForUser(collection.value, 'update');
		if (!permission) return false;

		if (context.isBatch.value === true) {
			return fieldEditable(permission.fields, archiveField);
		}

		if (isUnconditional(permission)) {
			return fieldEditable(permission.fields, archiveField);
		}

		if (capabilityReady.value === false) return false;
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
