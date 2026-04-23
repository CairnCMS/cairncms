import { defineInterface } from '@cairncms/utils';
import InterfaceInlineFields from './system-inline-fields.vue';

export default defineInterface({
	id: 'system-inline-fields',
	name: 'Inline Fields',
	description: 'Inline Fields',
	icon: 'deployed_code',
	component: InterfaceInlineFields,
	system: true,
	types: ['json'],
	group: 'standard',
	options: [],
});
