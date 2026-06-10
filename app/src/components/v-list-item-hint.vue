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
	margin: .5rem 0;
	color: var(--foreground-subdued);

	&:not(:only-child) {
		&:first-child {
			margin-right: .75rem;
		}

		&:last-child {
			margin-left: .75rem;
		}
	}

	@at-root {
		.v-list,
		.v-list-item {
			#{$this} {
				margin-top: .25rem;
				margin-bottom: .25rem;

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
