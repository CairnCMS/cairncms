<template>
	<div class="v-list-item-hint" :class="{ center }">
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

<style lang="scss" scoped>
.v-list-item-hint {
	$this: &;

	display: inline-flex;
	align-self: center;
	margin: 0.5rem 0;
	color: var(--foreground-subdued);

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
				margin-top: 0.25rem;
				margin-bottom: 0.25rem;

				&:not(:only-child) {
					&:first-child {
						margin-right: 1rem;
					}

					&:last-child {
						margin-left: 1rem;
					}
				}
			}

			&.nav {
				&.three-line,
				&.two-line {
					#{$this} {
						align-self: flex-start;

						&.center {
							align-self: center;
						}
					}
				}
			}
		}
	}
}
</style>
