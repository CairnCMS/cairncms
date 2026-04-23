<template>
	<div class="content-inner" :style="{ paddingLeft: `${depth * 18}px` }">
		<v-list-item-icon>
			<v-icon small :name="icon ?? 'label'" />
		</v-list-item-icon>
		<v-list-item-content><v-text-overflow :text="name" :highlight="search" /></v-list-item-content>
	</div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
	props: {
		icon: {
			type: String,
			default: null,
		},
		name: {
			type: String,
			required: true,
		},
		search: {
			type: String,
			default: null,
		},
		depth: {
			type: Number,
			default: 0,
		},
	},
});
</script>

<style scoped>
.content-inner {
	display: flex;
	align-items: center;
	width: 100%;
}
</style>
