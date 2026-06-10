<template>
	<div class="v-list-item-icon" :class="{ center }">
		<slot />
	</div>
</template>

<script setup lang="ts">
interface Props {
	center?: boolean;
}

withDefaults(defineProps<Props>(), {
	center: false,
});
</script>

<style>
body {
	--v-list-item-icon-color: var(--foreground-subdued);
}
</style>

<style lang="scss" scoped>
.v-list-item-icon {
	$this: &;

	display: inline-flex;
	align-self: center;
	margin: 0.5rem 0;

	&:not(:only-child) {
		&:first-child {
			margin-right: 0.75rem;
		}

		&:last-child {
			margin-left: 0.75rem;
		}
	}

	@at-root {
		.v-list,
		.v-list-item {
			#{$this} {
				--v-icon-color: var(--v-list-item-icon-color);

				margin-top: 0.25rem;
				margin-bottom: 0.25rem;

				&:not(:only-child) {
					&:first-child {
						margin-right: 0.5rem;
					}

					&:last-child {
						margin-left: 0.5rem;
					}
				}
			}

			&.nav #{$this} :slotted(.v-icon) {
				&.dense {
					--v-icon-size: 1.125rem;
				}
			}

			&.disabled #{$this} :slotted(.v-icon) {
				--v-icon-color: var(--foreground-subdued) !important;
			}
		}
	}
}
</style>
