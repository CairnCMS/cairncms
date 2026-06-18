<template>
	<v-menu attached class="language-select" :class="{ secondary }">
		<template #activator="{ toggle, active }">
			<button class="toggle" @click="toggle">
				<v-icon class="translate" name="translate" />
				<span class="display-value">{{ displayValue }}</span>
				<v-icon name="expand_more" :class="{ active }" />
				<span class="append-slot"><slot name="append" /></span>
			</button>
		</template>

		<v-list v-if="items">
			<v-list-item v-for="(item, index) in items" :key="index" @click="$emit('update:modelValue', item.value)">
				<div class="start">
					<div class="dot" :class="{ show: item.edited }"></div>
					{{ item.text }}
				</div>
				<div class="end">
					<v-progress-linear
						v-tooltip="`${Math.round((item.current / item.max) * 100)}%`"
						:value="item.progress"
						rounded
						colorful
					/>
				</div>
			</v-list-item>
		</v-list>
	</v-menu>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
	defineProps<{
		modelValue?: string;
		items?: Record<string, any>[];
		secondary?: boolean;
	}>(),
	{
		items: () => [],
	}
);

defineEmits(['update:modelValue']);

const displayValue = computed(() => {
	const item = props.items.find((item) => item.value === props.modelValue);
	return item?.text ?? props.modelValue;
});
</script>

<style lang="scss" scoped>
.toggle {
	--v-icon-color: var(--primary);
	--v-icon-color-hover: var(--primary-150);

	display: flex;
	align-items: center;
	width: 100%;
	height: var(--input-height);
	padding: var(--input-padding);
	color: var(--primary);
	text-align: left;
	background-color: var(--primary-alt);
	border-radius: var(--border-radius);

	.display-value {
		flex-grow: 1;
		margin-left: 0.5rem;
	}

	.append-slot:not(:empty) {
		margin-left: 0.5rem;
	}
}

.v-input .input {
	color: var(--primary);
	background-color: var(--primary-alt);
	border: 0px;
}

.v-icon {
	margin-left: 0.375rem;
}

.secondary {
	.toggle {
		--v-icon-color: var(--secondary);
		--v-icon-color-hover: var(--secondary-150);

		color: var(--secondary);
		background-color: var(--secondary-alt);
	}
}

.v-list {
	.v-list-item {
		display: flex;
		gap: 0.625rem;
		align-items: center;
		justify-content: space-between;
		white-space: nowrap;
		cursor: pointer;

		.start {
			display: flex;
			flex: 1;
			align-items: center;
		}

		.end {
			display: flex;
			flex-grow: 1;
			gap: 0.625rem;
			align-items: center;
			justify-content: flex-end;
			color: var(--foreground-subdued);
		}

		&:hover {
			background-color: var(--background-normal);
		}

		.dot {
			width: 0.5rem;
			height: 100%;

			&.show::before {
				display: block;
				width: 0.25rem;
				height: 0.25rem;
				background-color: var(--foreground-subdued);
				border-radius: 0.125rem;
				content: '';
			}
		}

		.v-progress-linear {
			max-width: 6.25rem;
		}
	}
}
</style>
