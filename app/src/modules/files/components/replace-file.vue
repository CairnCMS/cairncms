<template>
	<v-dialog
		:model-value="modelValue"
		@update:model-value="$emit('update:modelValue', false)"
		@esc="$emit('update:modelValue', false)"
	>
		<v-card v-if="file">
			<v-card-title>{{ t('replace_file') }}</v-card-title>
			<v-card-text>
				<v-upload v-if="replaceAllowed" :key="file.id" :preset="preset" :file-id="file.id" from-url @input="uploaded" />
				<v-notice v-else type="warning">{{ t('not_allowed') }}</v-notice>
			</v-card-text>
			<v-card-actions>
				<v-button secondary @click="$emit('update:modelValue', false)">{{ t('done') }}</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script lang="ts" setup>
import { useItemUpdateGate } from '@/composables/use-item-permissions';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

interface Props {
	modelValue?: boolean;
	file?: Record<string, any>;
	preset?: Record<string, any>;
}

const props = withDefaults(defineProps<Props>(), {
	modelValue: false,
	file: () => ({}),
	preset: () => ({}),
});

const emit = defineEmits(['update:modelValue', 'replaced']);

const { t } = useI18n();

const REPLACE_FIELDS = ['folder', 'filename_download', 'storage', 'type'];

const { updateAllowed, writableFields } = useItemUpdateGate({
	collection: ref('directus_files'),
	primaryKey: computed(() => props.file?.id ?? null),
	enabled: computed(() => props.modelValue === true),
	localReady: computed(() => props.modelValue === true && !!props.file?.id),
	itemSource: computed(() => props.file),
});

const replaceAllowed = computed(() => {
	if (updateAllowed.value !== true) return false;
	const fields = writableFields.value;
	if (!fields) return false;
	if (fields.includes('*')) return true;
	return REPLACE_FIELDS.every((field) => fields.includes(field));
});

function uploaded(fileInfo: Record<string, any> | null) {
	if (!fileInfo) return;
	if (fileInfo.id !== props.file?.id) return;
	emit('update:modelValue', false);
	emit('replaced');
}
</script>

<style lang="scss" scoped>
.add-new {
	--v-button-background-color: var(--primary-10);
	--v-button-color: var(--primary);
	--v-button-background-color-hover: var(--primary-25);
	--v-button-color-hover: var(--primary);
}
</style>
