<template>
	<div class="label type-title selectable" :class="{ 'has-header': showHeader }" :style="{ color: color }">
		{{ text }}
	</div>
</template>

<script setup lang="ts">
withDefaults(
	defineProps<{
		showHeader?: boolean;
		text?: string;
		color?: string | undefined;
	}>(),
	{
		showHeader: false,
		text: '',
		color: undefined,
	}
);
</script>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
	inheritAttrs: false,
});
</script>

<style scoped>
.label {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 100%;
	font-weight: 800;
	font-size: 2.625rem;
	line-height: 3.25rem;
}

.label.has-header {
	height: calc(100% - 1.5rem);
}
</style>
