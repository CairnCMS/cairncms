<template>
	<div class="content-inner" :style="{ paddingLeft: `${depth * 18}px` }">
		<v-list-item-icon>
			<v-icon small :name="icon ?? 'label'" />
		</v-list-item-icon>
		<v-list-item-content><v-text-overflow :text="name" :highlight="search" /></v-list-item-content>
	</div>
</template>

<script setup lang="ts">
withDefaults(
	defineProps<{
		name: string;
		search?: string;
		icon?: string;
		depth?: number;
	}>(),
	{
		depth: 0,
	}
);
</script>

<style scoped>
.content-inner {
	display: flex;
	align-items: center;
	width: 100%;
}
</style>
