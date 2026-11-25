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

const contextNames = ['accountability', 'permissions', 'sensitiveValues', 'aliasMap'];

const contextMessage =
	'Make security context required. An optional accountability, permissions, sensitiveValues, or aliasMap lets a caller skip it without notice.';

const parameterHolders = `:matches(${[
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'TSDeclareFunction',
	'TSEmptyBodyFunctionExpression',
	'TSMethodSignature',
	'TSFunctionType',
	'TSConstructorType',
	'TSCallSignatureDeclaration',
	'TSConstructSignatureDeclaration',
	'TSParameterProperty',
].join(', ')})`;

/** Selectors for each way a declaration can make a context name matching `pattern` optional. */
function optionalContextSelectors(pattern) {
	// A key matches as a plain name or as a literal, so a computed identifier such as a symbol does not match.
	const key = `:matches([computed=false][key.name=${pattern}], [key.type='Literal'][key.value=${pattern}])`;
	const ownOptionsMember = `TSTypeAnnotation > TSTypeLiteral > TSPropertySignature${key}:not([optional=true])`;

	return [
		`${parameterHolders} > Identifier[optional=true][name=${pattern}]`,
		`${parameterHolders} > AssignmentPattern[left.name=${pattern}]`,
		`TSPropertySignature[optional=true]${key}`,
		`:matches(PropertyDefinition, TSAbstractPropertyDefinition)[optional=true]${key}`,
		`${parameterHolders} > ObjectPattern > Property${key}[value.type='AssignmentPattern']`,
		`${parameterHolders} > AssignmentPattern > ObjectPattern > Property${key}[value.type='AssignmentPattern']`,
		`${parameterHolders} > :matches(Identifier, ObjectPattern)[optional=true] > ${ownOptionsMember}`,
		`${parameterHolders} > AssignmentPattern > :matches(Identifier, ObjectPattern) > ${ownOptionsMember}`,
	];
}

// Each selects only the declarations an exception approves, so helpers and types nested inside them are still checked.
const functionOptions = (name, parameter = 'options') =>
	`FunctionDeclaration[id.name='${name}'] > Identifier[name='${parameter}'] > TSTypeAnnotation > TSTypeLiteral > TSPropertySignature`;

const methodParams = (owner, name) =>
	`ClassDeclaration[id.name='${owner}'] > ClassBody > MethodDefinition[key.name='${name}'][static=false][computed=false][kind='method'] > :matches(FunctionExpression, TSEmptyBodyFunctionExpression) > :matches(Identifier, AssignmentPattern)`;

const typeMembers = (name) => `TSTypeAliasDeclaration[id.name='${name}'] > TSTypeLiteral > TSPropertySignature`;
const interfaceMembers = (name) => `TSInterfaceDeclaration[id.name='${name}'] > TSInterfaceBody > TSPropertySignature`;

/** Builds the optional-context selectors, skipping the declarations `context` lists for each name. */
function contextSyntax(context = {}) {
	const unlisted = contextNames.filter((name) => !context[name]);
	const selectors = unlisted.length ? optionalContextSelectors(`/^(${unlisted.join('|')})$/`) : [];

	for (const [name, declarations] of Object.entries(context)) {
		const skip = `:not(${declarations.join(', ')})`;
		selectors.push(...optionalContextSelectors(`/^${name}$/`).map((selector) => `${selector}${skip}`));
	}

	return selectors.map((selector) => ({ selector, message: contextMessage }));
}

/**
 * Builds the boundary rules for an API block: every HTTP client except `clients`, every http and https value except
 * `names`, and every optional security context except the declarations in `context`. All API blocks use this one
 * helper, because a later block replaces a rule's options.
 */
function apiBoundaryRules({ clients = [], names = {}, context = {} } = {}) {
	const restricted = [...httpClients, ...nodeHttpModules].filter((name) => !clients.includes(name));
	const moduleNames = restricted.map((name) => name.replace(/[.*+?^$(){}|[\]\\/]/g, '\\$&')).join('|');
	const modulePattern = `/^(${moduleNames})(\\/.*)?$/`;

	const syntax = [
		{ selector: `CallExpression[callee.name='require'][arguments.0.value=${modulePattern}]`, message: outboundMessage },
		{ selector: `ImportExpression[source.value=${modulePattern}]`, message: outboundMessage },
		...contextSyntax(context),
	];

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
		'no-restricted-syntax': ['error', ...syntax],
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

const evaluatorMessage =
	'The app does not evaluate validation or permission rules outside form validation. Use server-computed capabilities.';

/** Builds the app rules that keep the shared validation evaluator out of app code, except the functions in `allowed`. */
function appEvaluatorRules(allowed = []) {
	return {
		'@typescript-eslint/no-restricted-imports': [
			'error',
			{
				paths: [
					{
						name: '@cairncms/utils',
						importNames: ['validatePayload', 'generateJoi'].filter((name) => !allowed.includes(name)),
						message: evaluatorMessage,
						allowTypeImports: true,
					},
				],
			},
		],
		'no-restricted-syntax': [
			'error',
			{ selector: "ImportExpression[source.value='@cairncms/utils']", message: evaluatorMessage },
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
		rules: apiBoundaryRules(),
	},
	{
		// The shared validated client.
		files: ['api/src/request/index.ts'],
		rules: apiBoundaryRules({ clients: ['axios'] }),
	},
	{
		// The validating agents the shared client connects through.
		files: ['api/src/request/agent-with-ip-validation.ts'],
		rules: apiBoundaryRules({ names: { 'node:http': ['Agent'], 'node:https': ['Agent'] } }),
	},
	{
		// The inbound HTTP and HTTPS server.
		files: ['api/src/server.ts'],
		rules: apiBoundaryRules({ names: { http: ['createServer'], https: ['Server'] } }),
	},
	{
		// The remote config client, built on the validating agents with the operator target check.
		files: ['api/src/cli/commands/config/operator-remote-transport.ts'],
		rules: apiBoundaryRules({ clients: ['axios'] }),
	},
	{
		// Trusted/system: the CLI bootstrap health check on a fixed localhost URL.
		files: ['api/src/cli/commands/init/index.ts'],
		rules: apiBoundaryRules({ clients: ['fetch'] }),
	},
	{
		// Trusted/system: mail delivery to the provider endpoint from operator configuration or the provider default.
		files: ['api/src/mailer.ts'],
		rules: apiBoundaryRules({
			clients: ['@aws-sdk/client-sesv2', 'nodemailer-mailgun-transport', 'nodemailer-sendgrid'],
		}),
	},
	{
		// Trusted/system: requests to the identity provider the operator configured.
		files: ['api/src/auth/drivers/oauth2.ts', 'api/src/auth/drivers/openid.ts'],
		rules: apiBoundaryRules({ clients: ['openid-client'] }),
	},
	{
		// Optional by design: the authenticate middleware sets the request's accountability.
		files: ['api/src/types/express.d.ts'],
		rules: apiBoundaryRules({ context: { accountability: [interfaceMembers('Request')] } }),
	},
	{
		// Optional by design: search throws without accountability, and aliasMap here is the join-alias table.
		files: ['api/src/utils/apply-query.ts'],
		rules: apiBoundaryRules({
			context: { accountability: [functionOptions('applyQuery')], aliasMap: [functionOptions('applyQuery')] },
		}),
	},
	{
		// Optional by design: in current-user mode, absent and null accountability deny. Full-access mode selects the system context.
		files: ['api/src/extensions/confined/broker.ts'],
		rules: apiBoundaryRules({ context: { accountability: [interfaceMembers('ConfinedHostBrokerDeps')] } }),
	},
	{
		// Optional by design: in current-user mode, absent and null accountability deny. Full-access mode selects the system context.
		files: ['api/src/extensions/confined/host-items.ts'],
		rules: apiBoundaryRules({ context: { accountability: [interfaceMembers('ConfinedItemsHostDeps')] } }),
	},
	{
		// Pending explicit context: services read a missing accountability as null, the system context.
		files: ['api/src/types/services.ts'],
		rules: apiBoundaryRules({ context: { accountability: [typeMembers('AbstractServiceOptions')] } }),
	},
	{
		// Pending explicit context: without accountability, the AST is built without permission filtering.
		files: ['api/src/utils/get-ast-from-query.ts'],
		rules: apiBoundaryRules({ context: { accountability: [typeMembers('GetASTOptions')] } }),
	},
	{
		// Pending explicit alias maps: without aliasMap, aliased concealed fields are not masked.
		files: ['api/src/services/payload.ts'],
		rules: apiBoundaryRules({
			context: {
				aliasMap: [
					methodParams('PayloadService', 'processValues'),
					methodParams('PayloadService', 'maskAliasedConcealedFields'),
				],
			},
		}),
	},
	{
		files: ['app/src/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,vue}'],
		ignores: ['app/src/**/*.test.ts'],
		rules: appEvaluatorRules(),
	},
	{
		// Form field validation rules and field conditions.
		files: ['app/src/utils/validate-item.ts', 'app/src/utils/apply-conditions.ts'],
		rules: appEvaluatorRules(['validatePayload']),
	},
]);
