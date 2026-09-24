import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { Field } from '@cairncms/types';
import { computed, ComputedRef, Ref } from 'vue';
import { cloneDeep } from 'lodash';
import { useCollection } from '@cairncms/composables';

export function useFieldPermissions(collection: Ref<string>, isNew: Ref<boolean>): { fields: ComputedRef<Field[]> } {
	const userStore = useUserStore();
	const permissionsStore = usePermissionsStore();

	const { fields: rawFields } = useCollection(collection);

	const fields = computed(() => {
		let fields = cloneDeep(rawFields.value);

		if (userStore.currentUser?.role?.admin_access === true) return fields;

		const permissions = permissionsStore.getPermissionsForUser(collection.value, isNew.value ? 'create' : 'update');

		// Keep unreadable fields out of the DOM.
		const readableFields = permissionsStore.getPermissionsForUser(collection.value, 'read')?.fields;

		if (readableFields && readableFields.includes('*') === false) {
			fields = fields.filter((field) => readableFields.includes(field.field));
		}

		if (!permissions) return fields;

		const writableFields = permissions.fields ?? [];

		if (writableFields.includes('*') === false) {
			fields = fields.map((field: Field) => {
				if (writableFields.includes(field.field) === false) {
					field.meta = {
						...(field.meta || {}),
						readonly: true,
						conditions: field.meta?.conditions?.map((condition) => ({ ...condition, readonly: true })),
					} as any;
				}

				return field;
			});
		}

		if (permissions.presets) {
			fields = fields.map((field: Field) => {
				if (field.field in permissions.presets!) {
					field.schema = {
						...(field.schema || {}),
						default_value: permissions.presets![field.field],
					} as any;
				}

				return field;
			});
		}

		return fields;
	});

	return { fields };
}
