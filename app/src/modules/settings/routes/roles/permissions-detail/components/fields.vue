<template>
	<div>
		<v-notice type="info">
			{{
				t('fields_for_role', {
					role: role ? role.name : t('public_label'),
					action: t(permission.action).toLowerCase(),
				})
			}}
		</v-notice>

		<p class="type-label">{{ t('field', 0) }}</p>
		<interface-select-multiple-checkbox
			:value="fields"
			type="json"
			:choices="fieldsInCollection"
			@input="fields = $event"
		/>

		<div v-if="appMinimal" class="app-minimal">
			<v-divider />
			<v-notice type="warning">{{ t('the_following_are_minimum_permissions') }}</v-notice>
			<pre class="app-minimal-preview">{{ appMinimal }}</pre>
		</div>
	</div>
</template>

<script setup lang="ts">
import { useFieldsStore } from '@/stores/fields';
import { useSync } from '@cairncms/composables';
import { Field, Permission, Role } from '@cairncms/types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
	permission: Permission;
	role?: Role;
	appMinimal?: Partial<Permission>;
}>();

const emit = defineEmits(['update:permission']);

const { t } = useI18n();

const fieldsStore = useFieldsStore();

const internalPermission = useSync(props, 'permission', emit);

const fieldsInCollection = computed(() => {
	const fields = fieldsStore.getFieldsForCollectionSorted(props.permission.collection);

	return fields.map((field: Field) => {
		return {
			text: field.name,
			value: field.field,
		};
	});
});

const fields = computed({
	get() {
		if (!internalPermission.value.fields) return [];

		if (internalPermission.value.fields.includes('*')) {
			return fieldsInCollection.value.map(({ value }: { value: string }) => value);
		}

		return internalPermission.value.fields;
	},
	set(newFields: string[] | null) {
		if (newFields && newFields.length > 0) {
			internalPermission.value = {
				...internalPermission.value,
				fields: newFields,
			};
		} else {
			internalPermission.value = {
				...internalPermission.value,
				fields: null,
			};
		}
	},
});
</script>

<style lang="scss" scoped>
.type-label {
	margin-bottom: 0.5rem;
}

.v-notice {
	margin-bottom: 2.25rem;
}

.app-minimal {
	.v-divider {
		margin: 1.5rem 0;
	}

	.v-notice {
		margin-bottom: 1.5rem;
	}

	.app-minimal-preview {
		padding: 1rem;
		font-family: var(--family-monospace);
		background-color: var(--background-subdued);
		border-radius: var(--border-radius);
	}
}
</style>
