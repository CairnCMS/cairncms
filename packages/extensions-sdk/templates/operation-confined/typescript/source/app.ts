import { defineOperationApp } from '@cairncms/extensions-sdk';

export default defineOperationApp({
	id: '__extension_name__',
	name: 'Custom',
	icon: 'box',
	description: 'This is my confined operation!',
	overview: ({ text }) => [
		{
			label: 'Text',
			text: text,
		},
	],
	options: [
		{
			field: 'text',
			name: 'Text',
			type: 'string',
			meta: {
				width: 'full',
				interface: 'input',
			},
		},
	],
});
