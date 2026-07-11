import { defineItemView } from '@cairncms/extensions-sdk';
import PaneComponent from './item-view.vue';

export default defineItemView({
	id: 'custom',
	name: 'Custom',
	icon: 'box',
	placements: {
		splitPane: {
			component: PaneComponent,
			minWidth: 400,
		},
	},
});
