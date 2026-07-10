<template>
	<v-menu placement="left-start" show-arrow>
		<template #activator="{ toggle }">
			<v-icon name="more_vert" clickable class="ctx-toggle" @click.stop="toggle" />
		</template>
		<v-list>
			<v-list-item clickable @click="$emit('open-settings')">
				<v-list-item-icon>
					<v-icon name="settings" />
				</v-list-item-icon>
				<v-list-item-content>
					{{ t('settings') }}
				</v-list-item-content>
			</v-list-item>
		</v-list>
	</v-menu>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

defineEmits(['open-settings']);

const { t } = useI18n();
</script>

<style lang="scss" scoped>
.ctx-toggle {
	--v-icon-color: var(--foreground-subdued);

	&:hover {
		--v-icon-color: var(--foreground-normal);
	}
}
</style>
