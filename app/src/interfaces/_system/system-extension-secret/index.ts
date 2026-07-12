import { defineInterface } from '@cairncms/utils';
import InterfaceSystemExtensionSecret from './system-extension-secret.vue';

export default defineInterface({
	id: 'system-extension-secret',
	name: '$t:interfaces.system-extension-secret.name',
	icon: 'key',
	component: InterfaceSystemExtensionSecret,
	types: ['string'],
	system: true,
	options: [],
});
