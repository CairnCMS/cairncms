import { describe, expect, vi, test } from 'vitest';
import { getAuthProviders } from '../../src/utils/get-auth-providers.js';

let factoryEnv: { [k: string]: any } = {};

vi.mock('../../src/env', () => ({
	default: new Proxy(
		{},
		{
			get(_target, prop) {
				return factoryEnv[prop as string];
			},
		}
	),
}));

const scenarios = [
	{
		name: 'when no providers configured',
		input: {},
		output: [],
	},
	{
		name: 'when no driver configured',
		input: {
			AUTH_PROVIDERS: 'example',
		},
		output: [],
	},

	{
		name: 'when single provider and driver are properly configured',
		input: {
			AUTH_PROVIDERS: 'example',
			AUTH_EXAMPLE_DRIVER: 'openid',
			AUTH_EXAMPLE_LABEL: 'Example',
			AUTH_EXAMPLE_ICON: 'hare',
		},
		output: [
			{
				name: 'example',
				driver: 'openid',
				label: 'Example',
				icon: 'hare',
			},
		],
	},

	{
		name: 'when multiple provider and driver are properly configured',
		input: {
			AUTH_PROVIDERS: 'example,custom',
			AUTH_EXAMPLE_DRIVER: 'openid',
			AUTH_EXAMPLE_LABEL: 'Example',
			AUTH_EXAMPLE_ICON: 'hare',
			AUTH_CUSTOM_DRIVER: 'openid',
			AUTH_CUSTOM_ICON: 'lock',
		},
		output: [
			{
				name: 'example',
				driver: 'openid',
				label: 'Example',
				icon: 'hare',
			},
			{
				name: 'custom',
				driver: 'openid',
				icon: 'lock',
			},
		],
	},
];

describe('get auth providers', () => {
	for (const scenario of scenarios) {
		test(scenario.name, () => {
			factoryEnv = scenario.input;
			expect(getAuthProviders()).toEqual(scenario.output);
		});
	}
});
