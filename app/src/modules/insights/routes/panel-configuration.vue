<template>
	<v-drawer
		:model-value="isOpen"
		:title="panel?.name || t('panel')"
		:subtitle="t('panel_options')"
		:icon="panel?.icon || 'insert_chart'"
		persistent
		@cancel="router.push(`/insights/${dashboardKey}`)"
	>
		<template #actions>
			<v-button v-tooltip.bottom="t('done')" :disabled="!canSave" icon rounded @click="stageChanges">
				<v-icon name="check" />
			</v-button>
		</template>

		<div class="content">
			<p class="type-label panel-type-label">{{ t('type') }}</p>

			<v-fancy-select
				:model-value="panel.type"
				class="select"
				:items="selectItems"
				:disabled="!fieldWritable('type')"
				@update:model-value="edits.type = $event"
			/>

			<extension-options
				v-if="panel.type"
				:model-value="panel.options"
				:options="customOptionsFields"
				type="panel"
				:extension="panel.type"
				raw-editor-enabled
				:disabled="!fieldWritable('options')"
				@update:model-value="edits.options = $event"
			/>

			<v-divider :inline-title="false" large>
				<template #icon><v-icon name="info" /></template>
				<template #default>{{ t('panel_header') }}</template>
			</v-divider>

			<div class="form-grid">
				<div class="field half-left">
					<p class="type-label">{{ t('visible') }}</p>
					<v-checkbox
						:model-value="panel.show_header"
						block
						:label="t('show_header')"
						:disabled="!fieldWritable('show_header')"
						@update:model-value="edits.show_header = $event"
					/>
				</div>

				<div class="field half-right">
					<p class="type-label">{{ t('name') }}</p>
					<v-input
						:model-value="panel.name"
						:nullable="false"
						:disabled="panel.show_header !== true || !fieldWritable('name')"
						:placeholder="t('panel_name_placeholder')"
						@update:model-value="edits.name = $event"
					/>
				</div>

				<div class="field half-left">
					<p class="type-label">{{ t('icon') }}</p>
					<interface-select-icon
						:value="panel.icon"
						:disabled="panel.show_header !== true || !fieldWritable('icon')"
						@input="edits.icon = $event"
					/>
				</div>

				<div class="field half-right">
					<p class="type-label">{{ t('color') }}</p>
					<interface-select-color
						:value="panel.color"
						:disabled="panel.show_header !== true || !fieldWritable('color')"
						width="half"
						@input="edits.color = $event"
					/>
				</div>

				<div class="field full">
					<p class="type-label">{{ t('note') }}</p>
					<v-input
						:model-value="panel.note"
						:disabled="panel.show_header !== true || !fieldWritable('note')"
						:placeholder="t('panel_note_placeholder')"
						@update:model-value="edits.note = $event"
					/>
				</div>
			</div>
		</div>
	</v-drawer>
</template>

<script lang="ts" setup>
import { useDialogRoute } from '@/composables/use-dialog-route';
import { useExtension } from '@/composables/use-extension';
import { useItemUpdateGate } from '@/composables/use-item-permissions';
import { useExtensions } from '@/extensions';
import { useInsightsStore } from '@/stores/insights';
import { CreatePanel } from '@/stores/insights';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { pickWritable } from '@/utils/pick-writable';
import { Panel } from '@cairncms/types';
import { assign, clone, merge, omitBy, isUndefined } from 'lodash';
import { nanoid } from 'nanoid/non-secure';
import { storeToRefs } from 'pinia';
import { computed, reactive, ref, unref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import ExtensionOptions from '../../settings/routes/data-model/field-detail/shared/extension-options.vue';

const COLLECTION = 'directus_panels';
const CONFIG_FIELDS = ['type', 'options', 'show_header', 'name', 'icon', 'color', 'note'];
const REQUIRED_CREATE = ['dashboard', 'type', 'position_x', 'position_y', 'width', 'height'];

interface Props {
	dashboardKey: string;
	panelKey: string;
}

const props = defineProps<Props>();

const { t } = useI18n();

const isOpen = useDialogRoute();

const edits = reactive<Partial<Panel>>({
	show_header: undefined,
	type: undefined,
	name: undefined,
	note: undefined,
	icon: undefined,
	color: undefined,
	width: undefined,
	height: undefined,
	position_x: undefined,
	position_y: undefined,
	options: undefined,
});

const insightsStore = useInsightsStore();

const { panels } = storeToRefs(insightsStore);
const { panels: panelTypes } = useExtensions();

const router = useRouter();

const insightsEdits = insightsStore.edits;
const permissionsStore = usePermissionsStore();
const userStore = useUserStore();

const isNewKey = computed(() => props.panelKey === '+');
const isStaged = computed(() => props.panelKey.startsWith('_'));
const isPersisted = computed(() => isNewKey.value === false && isStaged.value === false);

function resetEdits() {
	for (const key of Object.keys(edits)) (edits as Record<string, any>)[key] = undefined;
}

watch(
	() => [props.dashboardKey, props.panelKey, isOpen.value] as const,
	([newDash, newKey, newOpen], [oldDash, oldKey, oldOpen]) => {
		const targetChanged = newDash !== oldDash || newKey !== oldKey;
		const closed = oldOpen === true && newOpen === false;
		if (targetChanged || closed) resetEdits();
	}
);

const existingPanel = computed(() => unref(panels).find((p) => p.id === props.panelKey));
const stagedEntry = computed(() => insightsEdits.create.find((p) => p.id === props.panelKey));

const localReady = computed(() => {
	if (isOpen.value !== true) return false;
	if (isNewKey.value) return true;
	if (isStaged.value) return !!stagedEntry.value;
	return !!existingPanel.value;
});

const isAdmin = computed(() => userStore.currentUser?.role?.admin_access === true);

const {
	updateAllowed,
	writableFields: updateWritableFields,
	fieldWritable: updateFieldWritable,
} = useItemUpdateGate({
	collection: ref(COLLECTION),
	primaryKey: computed(() => (isPersisted.value ? props.panelKey : null)),
	enabled: localReady,
	localReady,
	itemSource: existingPanel,
});

const createPermission = computed(() => permissionsStore.getPermissionsForUser(COLLECTION, 'create'));
const createPresets = computed<Record<string, any>>(() => createPermission.value?.presets ?? {});
const createAllowed = computed(() => localReady.value && permissionsStore.hasPermission(COLLECTION, 'create'));

const canEdit = computed(() => (isPersisted.value ? updateAllowed.value : createAllowed.value));

const writableFields = computed<string[] | null>(() => {
	if (isAdmin.value) return ['*'];
	if (isPersisted.value === false) return createPermission.value?.fields ?? null;
	return updateWritableFields.value;
});

function fieldWritable(name: string): boolean {
	if (isPersisted.value) return updateFieldWritable(name);
	if (createAllowed.value === false) return false;
	const fields = writableFields.value;
	return !!fields && (fields.includes('*') || fields.includes(name));
}

function writableForCreate(col: string): boolean {
	const fields = writableFields.value;
	return !!fields && (fields.includes('*') || fields.includes(col));
}

const hasWritableContent = computed(() => {
	const fields = writableFields.value;
	if (!fields) return false;
	if (fields.includes('*')) return true;
	return CONFIG_FIELDS.some((field) => fields.includes(field));
});

const effectiveType = computed<string | null>(() => {
	const edited = edits.type as string | null | undefined;

	if (isPersisted.value) {
		if (edited !== undefined) return edited;
		return (existingPanel.value?.type as string | undefined) ?? null;
	}

	if (writableForCreate('type')) {
		if (edited !== undefined) return edited;
		return (
			(isStaged.value ? ((existingPanel.value ?? stagedEntry.value)?.type as string | undefined) : undefined) ??
			(createPresets.value.type as string | undefined) ??
			null
		);
	}

	return (createPresets.value.type as string | undefined) ?? null;
});

const currentTypeInfo = useExtension('panel', effectiveType);

const effectiveDashboard = computed<string>(() =>
	writableForCreate('dashboard') ? props.dashboardKey : createPresets.value.dashboard ?? props.dashboardKey
);

const manufacturedDefaults = computed<Record<string, any>>(() => ({
	options: {},
	width: currentTypeInfo.value?.minWidth ?? 4,
	height: currentTypeInfo.value?.minHeight ?? 4,
	position_x: 1,
	position_y: 1,
}));

const effectivePanel = computed<Partial<Panel>>(() => {
	const fields = writableFields.value;
	const all = !!fields && fields.includes('*');
	const canWrite = (key: string) => all || (!!fields && fields.includes(key));

	const result: Record<string, any> = merge({}, manufacturedDefaults.value, createPresets.value);

	const staged = isStaged.value ? existingPanel.value ?? stagedEntry.value ?? {} : {};

	for (const [key, value] of Object.entries(staged)) {
		if (key !== 'id' && canWrite(key)) result[key] = value;
	}

	for (const [key, value] of Object.entries(omitBy(edits, isUndefined))) {
		if (canWrite(key)) result[key] = value;
	}

	result.type = effectiveType.value;
	result.dashboard = effectiveDashboard.value;
	return result;
});

const createSatisfiable = computed(() =>
	REQUIRED_CREATE.every((col) => {
		const value = writableForCreate(col)
			? (effectivePanel.value as Record<string, any>)[col]
			: createPresets.value[col];

		return value !== undefined && value !== null;
	})
);

const requiredNotNulled = computed(() => {
	const content = pickWritable(omitBy(edits, isUndefined), writableFields.value);
	return !REQUIRED_CREATE.some((col) => content[col] === null);
});

const canSave = computed(() => {
	if (isNewKey.value || isStaged.value) return canEdit.value && createSatisfiable.value;
	return updateAllowed.value && hasWritableContent.value && requiredNotNulled.value;
});

const panel = computed<Partial<Panel>>(() => {
	if (isPersisted.value) return assign({}, existingPanel.value ?? {}, omitBy(edits, isUndefined));
	return effectivePanel.value;
});

const selectItems = computed<FancySelectItem[]>(() => {
	return panelTypes.value.map((panelType) => {
		const item: FancySelectItem = {
			text: panelType.name,
			icon: panelType.icon,
			description: panelType.description,
			value: panelType.id,
		};

		return item;
	});
});

const customOptionsFields = computed(() => {
	if (typeof currentTypeInfo.value?.options === 'function') {
		return currentTypeInfo.value?.options(unref(panel)) ?? null;
	}

	return null;
});

const stageChanges = () => {
	if (canSave.value !== true) return;

	if (isNewKey.value || isStaged.value) {
		const reconciled = clone(unref(effectivePanel)) as Partial<Panel>;

		if (isNewKey.value) {
			reconciled.id = `_${nanoid()}`;
		} else {
			reconciled.id = props.panelKey;
			insightsStore.stagePanelDelete(props.panelKey);
		}

		insightsStore.stagePanelCreate(reconciled as CreatePanel, writableFields.value);
		router.push(`/insights/${props.dashboardKey}`);
		return;
	}

	const content = pickWritable(omitBy(edits, isUndefined), writableFields.value);

	if (Object.keys(content).length === 0) {
		router.push(`/insights/${props.dashboardKey}`);
		return;
	}

	insightsStore.stagePanelUpdate({ id: props.panelKey, edits: content });
	router.push(`/insights/${props.dashboardKey}`);
};
</script>

<style scoped>
.content {
	padding: var(--content-padding);
	padding-top: 0;
	padding-bottom: var(--content-padding-bottom);
}

.select {
	margin-bottom: 2rem;
}

.panel-type-label {
	margin-bottom: 1rem;
}

.v-divider {
	margin: 4.25rem 0 3rem;
}
</style>
