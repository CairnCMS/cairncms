import { defineInterface } from '@cairncms/utils';
import InterfaceSystemFieldTree from './system-field-tree.vue';

export default defineInterface({
	id: 'system-field-tree',
	name: '$t:field',
	icon: 'deployed_code',
	component: InterfaceSystemFieldTree,
	types: ['string'],
	options: [],
	system: true,
});
