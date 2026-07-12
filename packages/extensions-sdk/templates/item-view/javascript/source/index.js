import PaneComponent from './item-view.vue';

export default {
	id: 'custom',
	name: 'Custom',
	icon: 'box',
	placements: {
		splitPane: {
			component: PaneComponent,
			minWidth: 400,
		},
	},
};
