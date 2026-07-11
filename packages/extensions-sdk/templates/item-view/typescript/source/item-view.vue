<template>
	<div class="pane">This is my custom item view for {{ collection }}!</div>
</template>

<script lang="ts">
import { useItemViewContext } from '@cairncms/extensions-sdk';
import { defineComponent } from 'vue';

export default defineComponent({
	setup() {
		const { collection } = useItemViewContext();

		return { collection };
	},
});
</script>

<style scoped>
.pane {
	padding: 12px;
}
</style>
