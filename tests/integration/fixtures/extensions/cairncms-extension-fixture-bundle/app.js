import { h } from 'vue';

export const interfaces = [
	{
		id: 'cairn-fixture-bundle-interface',
		name: 'Cairn Fixture Bundle Interface',
		icon: 'box',
		component: {
			setup: () => () => h('div', 'cairn fixture bundle interface'),
		},
		types: ['string'],
	},
];
