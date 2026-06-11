<template>
	<span
		v-if="internalActive"
		class="v-chip"
		:class="[sizeClass, { outlined, label, disabled, close }]"
		@click="onClick"
	>
		<span class="chip-content">
			<slot />
			<span v-if="close" class="close-outline" :class="{ disabled }" @click.stop="onCloseClick">
				<v-icon class="close" :name="closeIcon" x-small />
			</span>
		</span>
	</span>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useSizeClass } from '@cairncms/composables';

interface Props {
	/** Model the active state */
	active?: boolean;
	/** Displays a close icon which triggers the close event */
	close?: boolean;
	/** Which icon should be displayed to close it */
	closeIcon?: string;
	/** No background */
	outlined?: boolean;
	/** Adds a border radius */
	label?: boolean;
	/** Disables the chip */
	disabled?: boolean;
	/** Renders a smaller chip */
	xSmall?: boolean;
	/** Renders a small chip */
	small?: boolean;
	/** Renders a large chip */
	large?: boolean;
	/** Renders a larger chip */
	xLarge?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	active: undefined,
	close: false,
	closeIcon: 'close',
	outlined: false,
	label: true,
	disabled: false,
});

const emit = defineEmits(['update:active', 'click', 'close']);

const internalLocalActive = ref(true);

const internalActive = computed<boolean>({
	get: () => {
		if (props.active !== undefined) return props.active;
		return internalLocalActive.value;
	},
	set: (active: boolean) => {
		emit('update:active', active);
		internalLocalActive.value = active;
	},
});

const sizeClass = useSizeClass(props);

function onClick(event: MouseEvent) {
	if (props.disabled) return;
	emit('click', event);
}

function onCloseClick(event: MouseEvent) {
	if (props.disabled) return;
	internalActive.value = !internalActive.value;
	emit('close', event);
}
</script>

<style>
body {
	--v-chip-color: var(--foreground-normal);
	--v-chip-background-color: var(--background-normal-alt);
	--v-chip-color-hover: var(--white);
	--v-chip-background-color-hover: var(--primary-125);
	--v-chip-close-color: var(--danger);
	--v-chip-close-color-disabled: var(--primary);
	--v-chip-close-color-hover: var(--primary-125);
}
</style>

<style lang="scss" scoped>
.v-chip {
	display: inline-flex;
	align-items: center;
	height: 2.25rem;
	padding: 0 0.5rem;
	color: var(--v-chip-color);
	font-weight: var(--weight-normal);
	line-height: 1.375rem;
	background-color: var(--v-chip-background-color);
	background-clip: padding-box;
	border: var(--border-width) solid var(--v-chip-background-color);
	border-radius: 1rem;

	&.clickable:hover {
		color: var(--v-chip-color-hover);
		background-color: var(--v-chip-background-color-hover);
		border-color: var(--v-chip-background-color-hover);
		cursor: pointer;
	}

	&.outlined {
		background-color: transparent;
	}

	&.disabled {
		color: var(--v-chip-color);
		background-color: var(--v-chip-background-color);
		border-color: var(--v-chip-background-color);

		&.clickable:hover {
			color: var(--v-chip-color);
			background-color: var(--v-chip-background-color);
			border-color: var(--v-chip-background-color);
		}
	}

	&.x-small {
		height: 1.25rem;
		padding: 0 0.25rem;
		font-size: 0.75rem;
		border-radius: 0.625rem;
	}

	&.small {
		height: var(--v-chip-height-small, 1.5rem);
		padding: var(--v-chip-padding-small, 0 0.25rem);
		font-size: 0.875rem;
		border-radius: var(--v-chip-border-radius-small, 0.75rem);
	}

	&.large {
		height: 2.75rem;
		padding: 0 1.25rem;
		font-size: 1rem;
		border-radius: 1.375rem;
	}

	&.x-large {
		height: 3rem;
		padding: 0 1.25rem;
		font-size: 1.125rem;
		border-radius: 1.5rem;
	}

	&.label {
		border-radius: var(--border-radius);
	}

	.chip-content {
		display: inline-flex;
		align-items: center;
		white-space: nowrap;

		.close-outline {
			position: relative;
			right: -0.25rem;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 0.875rem;
			height: 0.875rem;
			margin-left: 0.25rem;
			background-color: var(--v-chip-close-color);
			border-radius: 0.625rem;

			.close {
				--v-icon-color: var(--v-chip-background-color);
			}

			&.disabled {
				background-color: var(--v-chip-close-color-disabled);

				&:hover {
					background-color: var(--v-chip-close-color-disabled);
				}
			}

			&:hover {
				background-color: var(--v-chip-close-color-hover);
			}
		}
	}
}
</style>
