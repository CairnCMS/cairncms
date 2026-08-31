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

		// remove fields without read permissions so they don't show up in the DOM
		const readableFields = permissionsStore.getPermissionsForUser(collection.value, 'read')?.fields;

		if (readableFields && readableFields.includes('*') === false) {
			fields = fields.filter((field) => readableFields.includes(field.field));
		}

		if (!permissions) return fields;

		if (permissions.fields?.includes('*') === false) {
			fields = fields.map((field: Field) => {
				if (permissions.fields?.includes(field.field) === false) {
					field.meta = {
						...(field.meta || {}),
						readonly: true,
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
