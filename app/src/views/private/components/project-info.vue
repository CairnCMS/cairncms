<template>
	<div class="project-info">
		<div class="name-container">
			<v-text-overflow placement="right" class="name" :text="name" />
			<v-text-overflow v-if="descriptor" placement="right" class="descriptor" :text="descriptor" />
		</div>
	</div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';
import { useServerStore } from '@/stores/server';

export default defineComponent({
	setup() {
		const serverStore = useServerStore();

		const name = computed(() => serverStore.info?.project?.project_name);
		const descriptor = computed(() => serverStore.info?.project?.project_descriptor);

		return { name, descriptor };
	},
});
</script>

<style lang="scss" scoped>
.project-info {
	position: relative;
	display: flex;
	align-items: center;
	width: 100%;
	height: 60px;
	padding-left: 20px;
	color: var(--foreground-normal-alt);
	text-align: left;
	background-color: var(--background-page);
	border-bottom: 1px solid var(--border-normal);

	.name-container {
		flex-grow: 1;
		width: 100px;
		line-height: 1.3;
	}

	.name {
		margin-right: 8px;
		font-size: 18px;
	}

	.descriptor {
		display: block;
		color: var(--foreground-subdued);
	}
}
</style>
