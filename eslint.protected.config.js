const { defineConfig } = require('eslint/config');
const comments = require('@eslint-community/eslint-plugin-eslint-comments');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const vueParser = require('vue-eslint-parser');
const main = require('./eslint.config.js');

const outboundMessage =
	'Outbound HTTP goes through getAxios() in api/src/request, or an approved file listed in eslint.protected.config.js.';

const httpClients = [
	'axios',
	'node-fetch',
	'got',
	'undici',
	'request',
	'superagent',
	'ky',
	'ofetch',
	'cross-fetch',
	'isomorphic-fetch',
	'needle',
	'openid-client',
	'@aws-sdk/client-sesv2',
	'nodemailer-mailgun-transport',
	'nodemailer-sendgrid',
	'http2',
	'node:http2',
];

const nodeHttpModules = ['http', 'node:http', 'https', 'node:https'];

// The only values from Node's http and https modules that any file may import, because none sends a request.
const nodeHttpSafeNames = ['STATUS_CODES', 'METHODS', 'validateHeaderName', 'validateHeaderValue'];

/** Builds the outbound HTTP rules without the given clients, allowing the given extra values from http and https. */
function outboundRules(clients = [], names = {}) {
	const restricted = [...httpClients, ...nodeHttpModules].filter((name) => !clients.includes(name));
	const moduleNames = restricted.map((name) => name.replace(/[./]/g, '\\$&')).join('|');
	const modulePattern = `/^(${moduleNames})(\\/.*)?$/`;

	return {
		'@typescript-eslint/no-restricted-imports': [
			'error',
			{
				paths: restricted.map((name) => ({
					name,
					message: outboundMessage,
					allowTypeImports: true,
					...(name === 'axios' && { allowImportNames: ['isAxiosError'] }),
					...(nodeHttpModules.includes(name) && {
						allowImportNames: [...nodeHttpSafeNames, ...(names[name] ?? [])],
					}),
				})),
				patterns: [{ regex: `^(${moduleNames})/`, message: outboundMessage, allowTypeImports: true }],
			},
		],
		'no-restricted-syntax': [
			'error',
			{
				selector: `CallExpression[callee.name='require'][arguments.0.value=${modulePattern}]`,
				message: outboundMessage,
			},
			{ selector: `ImportExpression[source.value=${modulePattern}]`, message: outboundMessage },
		],
		'no-restricted-globals': clients.includes('fetch') ? 'off' : ['error', { name: 'fetch', message: outboundMessage }],
		'no-restricted-properties': clients.includes('fetch')
			? 'off'
			: [
					'error',
					{ object: 'globalThis', property: 'fetch', message: outboundMessage },
					{ object: 'global', property: 'fetch', message: outboundMessage },
			  ],
	};
}

// Run with --no-inline-config, so no comment in a source file can switch these checks off.
module.exports = defineConfig([
	...main.filter((entry) => entry.ignores && !entry.files),
	{
		files: ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,vue}'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			parserOptions: { ecmaFeatures: { jsx: true } },
		},
		plugins: { '@typescript-eslint': tsPlugin, '@eslint-community/eslint-comments': comments },
		rules: {
			'@typescript-eslint/ban-ts-comment': [
				'error',
				{
					'ts-check': false,
					'ts-expect-error': { descriptionFormat: '[A-Za-z]{3}' },
					'ts-ignore': true,
					'ts-nocheck': false,
				},
			],
			// TypeScript honors the nocheck directive in any letter case. The rule above matches lowercase only.
			'no-warning-comments': ['error', { terms: ['@ts-nocheck'], location: 'anywhere' }],
			'@eslint-community/eslint-comments/require-description': 'error',
			'@eslint-community/eslint-comments/no-unlimited-disable': 'error',
			'@eslint-community/eslint-comments/no-use': [
				'error',
				{ allow: ['eslint-disable', 'eslint-disable-line', 'eslint-disable-next-line', 'eslint-enable'] },
			],
		},
	},
	{ files: ['**/*.{ts,cts,mts,tsx}'], languageOptions: { parser: tsParser } },
	{ files: ['**/*.vue'], languageOptions: { parser: vueParser, parserOptions: { parser: tsParser } } },
	{ files: ['**/*.{cjs,cts}'], languageOptions: { sourceType: 'commonjs' } },
	{
		files: ['api/src/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'],
		ignores: ['api/src/**/*.test.ts', 'api/src/**/__fixtures__/**', 'api/src/**/__mocks__/**', 'api/src/__utils__/**'],
		rules: outboundRules(),
	},
	{
		// The shared validated client.
		files: ['api/src/request/index.ts'],
		rules: outboundRules(['axios']),
	},
	{
		// The validating agents the shared client connects through.
		files: ['api/src/request/agent-with-ip-validation.ts'],
		rules: outboundRules([], { 'node:http': ['Agent'], 'node:https': ['Agent'] }),
	},
	{
		// The inbound HTTP and HTTPS server.
		files: ['api/src/server.ts'],
		rules: outboundRules([], { http: ['createServer'], https: ['Server'] }),
	},
	{
		// The remote config client, built on the validating agents with the operator target check.
		files: ['api/src/cli/commands/config/operator-remote-transport.ts'],
		rules: outboundRules(['axios']),
	},
	{
		// Trusted/system: the CLI bootstrap health check on a fixed localhost URL.
		files: ['api/src/cli/commands/init/index.ts'],
		rules: outboundRules(['fetch']),
	},
	{
		// Trusted/system: mail delivery to the provider endpoint from operator configuration or the provider default.
		files: ['api/src/mailer.ts'],
		rules: outboundRules(['@aws-sdk/client-sesv2', 'nodemailer-mailgun-transport', 'nodemailer-sendgrid']),
	},
	{
		// Trusted/system: requests to the identity provider the operator configured.
		files: ['api/src/auth/drivers/oauth2.ts', 'api/src/auth/drivers/openid.ts'],
		rules: outboundRules(['openid-client']),
	},
]);
