<template>
	<div class="v-slider" :style="styles">
		<div v-if="$slots.prepend" class="prepend">
			<slot name="prepend" :value="modelValue" />
		</div>
		<div class="slider" :class="{ disabled, 'thumb-label-visible': showThumbLabel && alwaysShowValue }">
			<input
				:disabled="disabled"
				type="range"
				:value="modelValue"
				:max="max"
				:min="min"
				:step="step"
				@change="onChange"
				@input="onInput"
			/>
			<div class="fill" />
			<div v-if="showTicks" class="ticks">
				<span v-for="i in Math.floor((max - min) / step) + 1" :key="i" class="tick" />
			</div>
			<div v-if="showThumbLabel" class="thumb-label-wrapper">
				<div class="thumb-label" :class="{ visible: alwaysShowValue }">
					<slot name="thumb-label type-text" :value="modelValue">
						{{ modelValue }}
					</slot>
				</div>
			</div>
		</div>
		<div v-if="$slots.append" class="append">
			<slot name="append" :value="modelValue" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
	/** Disables the slider */
	disabled?: boolean;
	/** Show the thumb label on drag of the thumb */
	showThumbLabel?: boolean;
	/** Maximum allowed value */
	max?: number;
	/** Minimum allowed value */
	min?: number;
	/** In what step the value can be entered */
	step?: number;
	/** Show tick for each step */
	showTicks?: boolean;
	/** Always the current selected value */
	alwaysShowValue?: boolean;
	/** Model the current selected value */
	modelValue?: number;
}

const props = withDefaults(defineProps<Props>(), {
	disabled: false,
	showThumbLabel: false,
	max: 100,
	min: 0,
	step: 1,
	showTicks: false,
	alwaysShowValue: true,
	modelValue: 0,
});

const emit = defineEmits(['change', 'update:modelValue']);

const styles = computed(() => {
	if (props.modelValue === null) return { '--_v-slider-percentage': 50 };

	let percentage = ((props.modelValue - props.min) / (props.max - props.min)) * 100;
	if (isNaN(percentage)) percentage = 0;
	return { '--_v-slider-percentage': percentage };
});

function onChange(event: Event) {
	const target = event.target as HTMLInputElement;
	emit('change', Number(target.value));
}

function onInput(event: Event) {
	const target = event.target as HTMLInputElement;
	emit('update:modelValue', Number(target.value));
}
</script>

<style>
body {
	--v-slider-color: var(--border-normal);
	--v-slider-thumb-color: var(--primary);
	--v-slider-fill-color: var(--primary);
}
</style>

<style lang="scss" scoped>
.v-slider {
	display: flex;
	align-items: center;

	.prepend {
		margin-right: 0.5rem;
	}

	.slider {
		position: relative;
		top: -0.1875rem;
		flex-grow: 1;

		&.disabled {
			--v-slider-thumb-color: var(--foreground-subdued);
			--v-slider-fill-color: var(--foreground-subdued);
		}

		&.thumb-label-visible {
			margin-bottom: 1.875rem;
		}

		input {
			width: 100%;
			height: 0.25rem;
			padding: 0.5rem 0;
			background-color: var(--background-page);
			background-image: var(--v-slider-track-background-image);
			border-radius: 0.625rem;
			cursor: pointer;
			appearance: none;

			&::-webkit-slider-runnable-track {
				height: 0.25rem;
				background: var(--v-slider-color);
				border: none;
				border-radius: 0.125rem;
				box-shadow: none;
			}

			&::-moz-range-track {
				height: 0.25rem;
				background: var(--v-slider-color);
				border: none;
				border-radius: 0.125rem;
				box-shadow: none;
			}

			&::-webkit-slider-thumb {
				position: relative;
				z-index: 3;
				width: 0.5rem;
				height: 0.5rem;
				margin-top: -0.125rem;
				background: var(--background-page);
				border: none;
				border-radius: 50%;
				box-shadow: none;
				box-shadow: 0 0 0 4px var(--v-slider-thumb-color);
				transition: all var(--fast) var(--transition);
				appearance: none;
			}

			&::-moz-range-thumb {
				position: relative;
				z-index: 3;
				width: 0.5rem;
				height: 0.5rem;
				margin-top: -0.125rem;
				background: var(--v-slider-thumb-color);
				border: none;
				border-radius: 50%;
				box-shadow: none;
				box-shadow: 0 0 0 4px var(--v-slider-thumb-color);
				transition: all var(--fast) var(--transition);
				appearance: none;
			}
		}

		.fill {
			position: absolute;
			top: 50%;
			right: 0;
			left: 0;
			z-index: 2;
			width: 100%;
			height: 0.25rem;
			background-color: var(--v-slider-fill-color);
			border-radius: 0.125rem;
			transform: translateY(-0.3125rem) scaleX(calc(var(--_v-slider-percentage) / 100));
			transform-origin: left;
			pointer-events: none;
		}

		.ticks {
			position: absolute;
			top: 0.875rem;
			left: 0;
			z-index: 2;
			display: flex;
			align-items: center;
			justify-content: space-between;
			width: 100%;
			height: 0.25rem;
			padding: 0 0.4375rem;
			opacity: 0;
			transition: opacity var(--fast) var(--transition);
			pointer-events: none;

			.tick {
				display: inline-block;
				width: 0.25rem;
				height: 0.25rem;
				background-color: var(--v-slider-color);
				border-radius: 50%;
			}
		}

		.thumb-label-wrapper {
			position: absolute;
			top: 100%;
			left: 0.4375rem;
			width: calc(100% - 0.875rem);
			overflow: visible;
			pointer-events: none;
		}

		.thumb-label {
			z-index: 1;
			position: absolute;
			top: 0px;
			left: calc(var(--_v-slider-percentage) * 1%);
			width: auto;
			padding: 0.125rem 0.375rem;
			color: var(--foreground-inverted);
			font-weight: 600;
			background-color: var(--primary);
			border-radius: var(--border-radius);
			transform: translateX(-50%);
			opacity: 0;
			transition: opacity var(--fast) var(--transition);

			&.visible {
				opacity: 1;
			}
		}

		&:hover:not(.disabled),
		&:focus-within:not(.disabled) {
			input {
				height: 0.25rem;

				&::-webkit-slider-thumb {
					width: 0.75rem;
					height: 0.75rem;
					margin-top: -0.25rem;
					box-shadow: 0 0 0 4px var(--v-slider-thumb-color);
					cursor: ew-resize;
				}

				&::-moz-range-thumb {
					width: 0.75rem;
					height: 0.75rem;
					margin-top: -0.25rem;
					box-shadow: 0 0 0 4px var(--v-slider-thumb-color);
					cursor: ew-resize;
				}
			}

			.thumb-label {
				opacity: 1;
			}
		}

		&:active:not(.disabled) {
			.thumb-label,
			.ticks {
				opacity: 1;
			}
		}
	}

	.append {
		margin-left: 0.5rem;
	}
}
</style>
