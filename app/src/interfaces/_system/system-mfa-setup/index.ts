import { defineInterface } from '@cairncms/utils';
import InterfaceSystemMFASetup from './system-mfa-setup.vue';

export default defineInterface({
	id: 'system-mfa-setup',
	name: 'mfa-setup',
	icon: 'deployed_code',
	component: InterfaceSystemMFASetup,
	types: ['text'],
	options: [],
	system: true,
});
