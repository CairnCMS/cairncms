<template>
	<div class="v-avatar" :class="[{ tile }, sizeClass]">
		<slot />
	</div>
</template>

<script setup lang="ts">
import { useSizeClass } from '@cairncms/composables';

interface Props {
	/** Render as a tile (square) */
	tile?: boolean;
	/** Renders a smaller avatar */
	xSmall?: boolean;
	/** Renders a small avatar */
	small?: boolean;
	/** Renders a large avatar */
	large?: boolean;
	/** Renders a larger avatar */
	xLarge?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	tile: false,
});

const sizeClass = useSizeClass(props);
</script>

<style>
body {
	--v-avatar-color: var(--background-normal);
	--v-avatar-size: 3rem;
}
</style>

<style scoped>
.v-avatar {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	width: var(--v-avatar-size);
	height: var(--v-avatar-size);
	overflow: hidden;
	color: var(--foreground-subdued);
	white-space: nowrap;
	text-overflow: ellipsis;
	background-color: var(--v-avatar-color);
	border-radius: var(--border-radius);
}

.tile {
	border-radius: 0;
}

.x-small {
	--v-avatar-size: 1.5rem;

	border-radius: 0.125rem;
}

.small {
	--v-avatar-size: 2.25rem;
}

.large {
	--v-avatar-size: 3.75rem;
}

.x-large {
	--v-avatar-size: 5rem;
}

:slotted(img) {
	width: 100%;
	height: 100%;
	object-fit: cover;
}
</style>
