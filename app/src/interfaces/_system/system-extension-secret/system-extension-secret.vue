<template>
	<v-input
		:placeholder="internalPlaceholder"
		:disabled="disabled"
		type="password"
		autocomplete="new-password"
		:model-value="localValue"
		:class="{ stored: isStored && !localValue }"
		@update:model-value="emitValue"
	>
		<template #append>
			<v-icon class="lock" :name="isStored && !localValue ? 'lock' : 'lock_open'" />
		</template>
	</v-input>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
	inheritAttrs: false,
});
</script>

<script setup lang="ts">
import { SECRET_MASK } from '@cairncms/constants';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
	value: string | null;
	disabled?: boolean;
	placeholder?: string;
}>();

const emit = defineEmits(['input']);

const { t } = useI18n();

const localValue = ref<string | null>(null);

const isStored = computed(() => props.value === SECRET_MASK);

const internalPlaceholder = computed(() => {
	return isStored.value && !localValue.value ? t('interfaces.system-extension-secret.value_stored') : props.placeholder;
});

watch(
	() => props.value,
	(newValue) => {
		if (newValue !== SECRET_MASK) localValue.value = newValue;
		else localValue.value = null;
	},
	{ immediate: true }
);

function emitValue(value: string | null) {
	localValue.value = value;
	emit('input', value === '' ? null : value);
}
</script>

<style lang="scss" scoped>
.v-input {
	--v-input-font-family: var(--family-monospace);
	--v-icon-color: var(--warning);

	&.stored {
		--v-icon-color: var(--primary);
	}
}

.lock {
	--v-icon-color: var(--warning);
}

.stored {
	--v-input-placeholder-color: var(--primary);

	.lock {
		--v-icon-color: var(--primary);
	}
}
</style>
