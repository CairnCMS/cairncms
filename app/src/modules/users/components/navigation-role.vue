<template>
	<v-list-item v-context-menu="'contextMenu'" :to="`/users/roles/${role.id}`">
		<v-list-item-icon><v-icon small :name="role.icon" /></v-list-item-icon>
		<v-list-item-content>{{ role.name }}</v-list-item-content>

		<v-menu v-if="isAdmin" ref="contextMenu" show-arrow placement="bottom-start">
			<v-list>
				<v-list-item clickable :to="`/settings/roles/${role.id}`">
					<v-list-item-icon>
						<v-icon name="list_alt" />
					</v-list-item-icon>
					<v-list-item-content>
						<v-text-overflow :text="t('edit_role')" />
					</v-list-item-content>
				</v-list-item>
			</v-list>
		</v-menu>
	</v-list-item>
</template>

<script setup lang="ts">
import { useUserStore } from '@/stores/user';
import { useI18n } from 'vue-i18n';
import { BasicRole } from '../composables/use-navigation';

defineProps<{
	role: BasicRole;
}>();

const { t } = useI18n();

const { isAdmin } = useUserStore();
</script>
