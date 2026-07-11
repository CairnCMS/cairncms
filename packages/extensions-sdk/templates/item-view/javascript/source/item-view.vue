<template>
	<div class="pane">This is my custom item view for {{ collection }}!</div>
</template>

<script>
import { useItemViewContext } from '@cairncms/extensions-sdk';

export default {
	setup() {
		const { collection } = useItemViewContext();

		return { collection };
	},
};
</script>

<style scoped>
.pane {
	padding: 12px;
}
</style>
