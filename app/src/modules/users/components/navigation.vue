<template>
	<v-list nav class="users-navigation">
		<v-list-item to="/users" exact :active="currentRole === null">
			<v-list-item-icon><v-icon small name="folder_shared" /></v-list-item-icon>
			<v-list-item-content>{{ t('all_users') }}</v-list-item-content>
		</v-list-item>

		<v-divider v-if="(roles && roles.length > 0) || loading" />

		<template v-if="loading">
			<v-list-item v-for="n in 4" :key="n">
				<v-skeleton-loader type="list-item-icon" />
			</v-list-item>
		</template>

		<navigation-role v-for="role in roles" :key="role.id" :role="role" :active="currentRole === role.id" />
	</v-list>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import useNavigation from '../composables/use-navigation';
import NavigationRole from './navigation-role.vue';

defineProps<{
	currentRole?: string;
}>();

const { t } = useI18n();

const { roles, loading } = useNavigation();
</script>

<style lang="scss" scoped>
.v-skeleton-loader {
	--v-skeleton-loader-background-color: var(--background-normal-alt);
}

.v-divider {
	--v-divider-color: var(--background-normal-alt);
}
</style>
