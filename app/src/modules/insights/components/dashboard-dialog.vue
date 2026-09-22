<template>
	<v-dialog :model-value="modelValue" persistent @update:model-value="$emit('update:modelValue', $event)" @esc="cancel">
		<template #activator="slotBinding">
			<slot name="activator" v-bind="slotBinding" />
		</template>

		<v-card>
			<v-card-title v-if="!dashboard">{{ t('create_dashboard') }}</v-card-title>
			<v-card-title v-else>{{ t('edit_dashboard') }}</v-card-title>

			<v-card-text>
				<div class="fields">
					<v-input
						v-model="values.name"
						class="full"
						autofocus
						:disabled="!fieldWritable('name')"
						:placeholder="t('dashboard_name')"
					/>
					<interface-select-icon
						:value="values.icon"
						:disabled="!fieldWritable('icon')"
						@input="values.icon = $event"
					/>
					<interface-select-color
						width="half"
						:value="values.color"
						:disabled="!fieldWritable('color')"
						@input="values.color = $event"
					/>
					<v-input v-model="values.note" class="full" :disabled="!fieldWritable('note')" :placeholder="t('note')" />
				</div>
			</v-card-text>

			<v-card-actions>
				<v-button secondary @click="cancel">
					{{ t('cancel') }}
				</v-button>
				<v-button :disabled="!saveAllowed" :loading="saving" @click="save">
					{{ t('save') }}
				</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import api from '@/api';
import {
	hasConditionalItemPermission,
	itemActionAllowed,
	useItemPermissions,
} from '@/composables/use-item-permissions';
import { router } from '@/router';
import { useInsightsStore } from '@/stores/insights';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { Dashboard } from '@/types/insights';
import { Permission } from '@cairncms/types';
import { unexpectedError } from '@/utils/unexpected-error';
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
	modelValue?: boolean;
	dashboard?: Dashboard;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void;
}>();

const { t } = useI18n();

const insightsStore = useInsightsStore();
const permissionsStore = usePermissionsStore();
const userStore = useUserStore();

const collection = ref('directus_dashboards');
const isNew = computed(() => !props.dashboard);
const primaryKey = computed<string | number | null>(() => props.dashboard?.id ?? null);

const capabilityEnabled = computed(
	() => props.modelValue === true && isNew.value === false && hasConditionalItemPermission(collection.value, ['update'])
);

const { itemPermissions } = useItemPermissions(
	collection,
	primaryKey,
	capabilityEnabled,
	computed(() => props.dashboard)
);

const isAdmin = computed(() => userStore.currentUser?.role?.admin_access === true);

const dialogFields = ['name', 'icon', 'color', 'note'];

const writableFields = computed<string[] | null>(() => {
	if (isAdmin.value) return ['*'];

	const action = isNew.value ? 'create' : 'update';
	const permission = permissionsStore.getPermissionsForUser(collection.value, action);
	if (!permission) return null;

	if (action === 'update' && isUnconditional(permission) === false) {
		return itemPermissions.value?.update.fields ?? null;
	}

	return permission.fields ?? null;
});

const saveAllowed = computed(() => {
	if (props.modelValue !== true) return false;
	if (saving.value) return false;
	if (!values.name) return false;

	if (isNew.value) {
		if (isAdmin.value) return true;
		return !!permissionsStore.getPermissionsForUser(collection.value, 'create');
	}

	const updatable = itemActionAllowed(
		collection.value,
		'update',
		itemPermissions.value,
		true,
		itemPermissions.value !== null
	);

	return updatable && dialogFields.some((field) => fieldWritable(field));
});

function isUnconditional(permission: Permission): boolean {
	return !permission.permissions || Object.keys(permission.permissions).length === 0;
}

function fieldWritable(field: string): boolean {
	const fields = writableFields.value;
	if (!fields) return false;
	return fields.includes('*') || fields.includes(field);
}

function writablePayload(): Record<string, any> {
	const fields = writableFields.value;
	const all = !!fields && fields.includes('*');
	const payload: Record<string, any> = {};

	for (const key of Object.keys(values)) {
		if (all || (fields && fields.includes(key))) payload[key] = values[key as keyof typeof values];
	}

	return payload;
}

const values = reactive({
	name: props.dashboard?.name ?? null,
	icon: props.dashboard?.icon ?? 'dashboard',
	color: props.dashboard?.color ?? null,
	note: props.dashboard?.note ?? null,
});

const saving = ref(false);

let sessionGeneration = 0;

watch([() => props.modelValue, () => props.dashboard?.id], () => {
	sessionGeneration++;
	saving.value = false;
	values.name = props.dashboard?.name ?? null;
	values.icon = props.dashboard?.icon ?? 'dashboard';
	values.color = props.dashboard?.color ?? null;
	values.note = props.dashboard?.note ?? null;
});

onUnmounted(() => {
	sessionGeneration++;
});

function cancel() {
	sessionGeneration++;
	saving.value = false;
	emit('update:modelValue', false);
}

async function save() {
	if (saveAllowed.value !== true) return;

	const token = ++sessionGeneration;
	saving.value = true;

	try {
		if (props.dashboard) {
			await api.patch(`/dashboards/${props.dashboard.id}`, writablePayload(), { params: { fields: ['id'] } });
			await insightsStore.hydrate();

			if (token !== sessionGeneration) return;
			emit('update:modelValue', false);
		} else {
			const response = await api.post('/dashboards', writablePayload(), { params: { fields: ['id'] } });
			await insightsStore.hydrate();

			if (token !== sessionGeneration) return;
			emit('update:modelValue', false);
			router.push(`/insights/${response.data.data.id}`);
		}
	} catch (err: any) {
		if (token === sessionGeneration) unexpectedError(err);
	} finally {
		if (token === sessionGeneration) saving.value = false;
	}
}
</script>

<style scoped>
.fields {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 0.75rem;
}

.full {
	grid-column: 1 / span 2;
}
</style>
