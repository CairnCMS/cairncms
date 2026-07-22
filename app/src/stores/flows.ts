import { FlowRaw } from '@cairncms/types';
import { fetchAll } from '@/utils/fetch-all';
import { defineStore } from 'pinia';
import { useUserStore } from '@/stores/user';
import { usePermissionsStore } from '@/stores/permissions';

export const useFlowsStore = defineStore({
	id: 'flowsStore',
	state: () => ({
		flows: [] as FlowRaw[],
	}),
	actions: {
		async hydrate() {
			const { isAdmin } = useUserStore();
			const { hasPermission } = usePermissionsStore();

			if (isAdmin !== true && !hasPermission('directus_flows', 'read')) {
				this.flows = [];
			} else {
				try {
					this.flows = await fetchAll<FlowRaw>('/flows', {
						params: { fields: ['*', 'operations.*'] },
					});
				} catch {
					this.flows = [];
				}
			}
		},
		async dehydrate() {
			this.$reset();
		},
		getManualFlowsForCollection(collection: string): FlowRaw[] {
			return this.flows.filter(
				(flow) =>
					flow.trigger === 'manual' && flow.status === 'active' && flow.options?.collections?.includes(collection)
			);
		},
	},
});
