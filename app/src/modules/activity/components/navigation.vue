<template>
	<v-list nav class="activity-navigation">
		<v-list-item clickable :active="!filterField" @click="clearNavFilter">
			<v-list-item-icon>
				<v-icon small name="access_time" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="t('all_activity')" />
			</v-list-item-content>
		</v-list-item>

		<v-list-item
			clickable
			:active="filterField === 'user' && filterValue === currentUserID"
			@click="setNavFilter('user', currentUserID)"
		>
			<v-list-item-icon>
				<v-icon small name="face" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="t('my_activity')" />
			</v-list-item-content>
		</v-list-item>

		<v-divider />

		<v-list-item
			clickable
			:active="filterField === 'action' && filterValue === 'create'"
			@click="setNavFilter('action', 'create')"
		>
			<v-list-item-icon>
				<v-icon small name="add" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="t('create')" />
			</v-list-item-content>
		</v-list-item>

		<v-list-item
			clickable
			:active="filterField === 'action' && filterValue === 'update'"
			@click="setNavFilter('action', 'update')"
		>
			<v-list-item-icon>
				<v-icon small name="check" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="t('update')" />
			</v-list-item-content>
		</v-list-item>

		<v-list-item
			clickable
			:active="filterField === 'action' && filterValue === 'delete'"
			@click="setNavFilter('action', 'delete')"
		>
			<v-list-item-icon>
				<v-icon small name="clear" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="t('delete_label')" />
			</v-list-item-content>
		</v-list-item>

		<v-list-item
			clickable
			:active="filterField === 'action' && filterValue === 'comment'"
			@click="setNavFilter('action', 'comment')"
		>
			<v-list-item-icon>
				<v-icon small name="chat_bubble_outline" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="t('comment')" />
			</v-list-item-content>
		</v-list-item>

		<v-list-item
			clickable
			:active="filterField === 'action' && filterValue === 'login'"
			@click="setNavFilter('action', 'login')"
		>
			<v-list-item-icon>
				<v-icon small name="login" />
			</v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="t('login')" />
			</v-list-item-content>
		</v-list-item>
	</v-list>
</template>

<script lang="ts">
import { useI18n } from 'vue-i18n';
import { defineComponent, computed, PropType } from 'vue';
import { useUserStore } from '@/stores/user';
import { Filter } from '@cairncms/types';

export default defineComponent({
	props: {
		filter: {
			type: Object as PropType<Filter>,
			default: null,
		},
	},
	emits: ['update:filter'],
	setup(props, { emit }) {
		const { t } = useI18n();

		const userStore = useUserStore();
		const currentUserID = computed(() => userStore.currentUser?.id);

		const filterField = computed(() => Object.keys(props.filter ?? {})[0] ?? null);
		const filterValue = computed(() => Object.values(props.filter ?? {})[0]?._eq ?? null);

		return { t, currentUserID, setNavFilter, clearNavFilter, filterField, filterValue };

		function setNavFilter(key: string, value: any) {
			emit('update:filter', {
				[key]: {
					_eq: value,
				},
			});
		}

		function clearNavFilter() {
			emit('update:filter', null);
		}
	},
});
</script>

<style lang="scss" scoped>
.activity-navigation {
	--v-list-item-active-rule-width: 2px;
	--v-list-item-active-rule-color: var(--primary);
	--v-list-item-border-radius-nav: 0;

	:deep(.v-list-item.active) {
		--v-list-item-icon-color: var(--primary);
	}
}
</style>
