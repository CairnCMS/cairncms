const { join } = require('node:path');
const { fixupPluginRules } = require('@eslint/compat');
const { defineConfig, includeIgnoreFile } = require('eslint/config');
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const vue = require('eslint-plugin-vue');
const vueParser = require('vue-eslint-parser');
const prettierConfig = require('eslint-config-prettier');
const prettierPlugin = require('eslint-plugin-prettier');
const globals = require('globals');

const codeFiles = ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,vue}'];

// Project rules and options that differ from the recommended presets.
const coreRules = {
	'no-constant-condition': [
		'error',
		{
			checkLoops: 'all',
		},
	],
	'no-inner-declarations': [
		'error',
		'functions',
		{
			blockScopedFunctions: 'disallow',
		},
	],
	// Attaching a cause can carry error details into logs and responses.
	'preserve-caught-error': 'off',
	'no-shadow-restricted-names': [
		'error',
		{
			reportGlobalThis: false,
		},
	],
	'no-unused-vars': [
		'error',
		{
			caughtErrors: 'none',
		},
	],
	'no-console': 'error',
	'padding-line-between-statements': [
		'error',
		{
			blankLine: 'always',
			prev: [
				'block',
				'block-like',
				'cjs-export',
				'class',
				'export',
				'import',
				'multiline-block-like',
				'multiline-const',
				'multiline-expression',
				'multiline-let',
				'multiline-var',
			],
			next: '*',
		},
		{
			blankLine: 'always',
			prev: ['const', 'let'],
			next: ['block', 'block-like', 'cjs-export', 'class', 'export', 'import'],
		},
		{
			blankLine: 'always',
			prev: '*',
			next: ['multiline-block-like', 'multiline-const', 'multiline-expression', 'multiline-let', 'multiline-var'],
		},
		{
			blankLine: 'any',
			prev: ['export', 'import'],
			next: ['export', 'import'],
		},
	],
	'lines-between-class-members': [
		'error',
		'always',
		{
			exceptAfterSingleLine: true,
		},
	],
	'no-nested-ternary': 'error',
};

const restrictedTypes = {
	String: {
		message: 'Use string instead',
		fixWith: 'string',
	},
	Boolean: {
		message: 'Use boolean instead',
		fixWith: 'boolean',
	},
	Number: {
		message: 'Use number instead',
		fixWith: 'number',
	},
	Symbol: {
		message: 'Use symbol instead',
		fixWith: 'symbol',
	},
	BigInt: {
		message: 'Use bigint instead',
		fixWith: 'bigint',
	},
	Function: {
		message:
			'The `Function` type accepts any function-like value.\nIt provides no type safety when calling the function, which can be a common source of bugs.\nIt also accepts things like class declarations, which will throw at runtime as they will not be called with `new`.\nIf you are expecting the function to accept certain arguments, you should explicitly define the function shape.',
	},
	Object: {
		message:
			'The `Object` type actually means "any non-nullish value", so it is marginally better than `unknown`.\n- If you want a type meaning "any object", you probably want `object` instead.\n- If you want a type meaning "any value", you probably want `unknown` instead.\n- If you really want a type meaning "any non-nullish value", you probably want `NonNullable<unknown>` instead.',
		suggest: ['object', 'unknown', 'NonNullable<unknown>'],
	},
	'{}': {
		message:
			'`{}` actually means "any non-nullish value".\n- If you want a type meaning "any object", you probably want `object` instead.\n- If you want a type meaning "any value", you probably want `unknown` instead.\n- If you want a type meaning "empty object", you probably want `Record<string, never>` instead.\n- If you really want a type meaning "any non-nullish value", you probably want `NonNullable<unknown>` instead.',
		suggest: ['object', 'unknown', 'Record<string, never>', 'NonNullable<unknown>'],
	},
};

const typescriptRules = {
	'no-class-assign': 'error',
	'no-new-native-nonconstructor': 'error',
	'no-with': 'error',
	'no-undef': 'off',
	'@typescript-eslint/ban-ts-comment': 'off',
	'@typescript-eslint/no-explicit-any': 'off',
	'@typescript-eslint/no-require-imports': 'off',
	// Off for TypeScript and Vue until their existing findings are fixed.
	'no-useless-assignment': 'off',
	'@typescript-eslint/no-unused-expressions': 'off',
	'@typescript-eslint/adjacent-overload-signatures': 'error',
	'@typescript-eslint/no-empty-function': 'error',
	'@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'never', allowObjectTypes: 'always' }],
	'@typescript-eslint/no-inferrable-types': 'error',
	'@typescript-eslint/no-unused-vars': [
		'warn',
		{
			argsIgnorePattern: '^_',
			varsIgnorePattern: '^_',
			caughtErrors: 'none',
		},
	],
	'@typescript-eslint/no-restricted-types': ['error', { types: restrictedTypes }],
};

module.exports = defineConfig([
	includeIgnoreFile(join(__dirname, '.gitignore')),
	{
		// Ignored by Git outside this repository or by a nested .gitignore, neither of which ESLint reads.
		ignores: ['.claude/**', '.codex/**', 'tests/integration/.artifacts/**'],
	},
	{
		files: codeFiles,
		extends: [js.configs.recommended],
		linterOptions: { reportUnusedDisableDirectives: 'error' },
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			parserOptions: { ecmaFeatures: { jsx: true } },
			globals: { ...globals.browser, ...globals.node },
		},
		plugins: { '@typescript-eslint': tsPlugin, vue },
		rules: coreRules,
	},
	{
		files: ['**/*.{ts,cts,mts,tsx,vue}'],
		extends: [tsPlugin.configs['flat/recommended'], vue.configs['flat/recommended']],
		languageOptions: { parser: tsParser, ecmaVersion: 2020, globals: globals.es2015 },
		rules: {
			...typescriptRules,
			'vue/comment-directive': ['error', { reportUnusedDisableDirectives: true }],
			'vue/jsx-uses-vars': 'error',
			'vue/multi-word-component-names': 'off',
			'vue/require-default-prop': 'off',
			'vue/no-required-prop-with-default': 'off',
		},
	},
	{
		files: ['**/*.vue'],
		languageOptions: { parser: vueParser, parserOptions: { parser: tsParser } },
		rules: { 'prefer-const': 'off' },
	},
	{
		// Test modules define stub components next to the component under test.
		files: ['app/src/**/*.test.ts'],
		rules: { 'vue/one-component-per-file': 'off' },
	},
	{
		files: ['tests/integration/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx,vue}'],
		languageOptions: { globals: globals.es2021 },
		// Vitest fixtures with no dependencies still take an empty object pattern as their first parameter.
		rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
	},
	{ files: ['**/*.{cjs,cts}'], languageOptions: { sourceType: 'commonjs' } },
	{
		// Keep the scaffolds' terminal-output examples without changing generated extension behavior.
		files: [
			'packages/extensions-sdk/templates/hook/{javascript,typescript}/source/index.{js,ts}',
			'packages/extensions-sdk/templates/operation/{javascript,typescript}/source/api.{js,ts}',
		],
		rules: { 'no-console': 'off' },
	},
	{
		// Vue declarations use empty generic placeholders. The other restricted types still fail.
		files: ['packages/extensions-sdk/templates/*/typescript/source/shims.d.ts'],
		rules: {
			'@typescript-eslint/no-restricted-types': [
				'error',
				{ types: Object.fromEntries(Object.entries(restrictedTypes).filter(([name]) => name !== '{}')) },
			],
		},
	},
	{
		// The VM loader reads these artifact exports from the global scope.
		files: ['tests/integration/fixtures/extensions/cairncms-extension-confined-*/{index,api}.js'],
		rules: {
			'no-unused-vars': [
				'error',
				{ caughtErrors: 'none', varsIgnorePattern: '^Cairn(?:Endpoint|Operation|Hook|Bundle)$' },
			],
		},
	},
	{
		// Destructuring intentionally omits protected fields from the fixture's update payload.
		files: ['tests/integration/fixtures/extensions/hooks/roles-continuity-barrier/index.js'],
		rules: { 'no-unused-vars': ['error', { caughtErrors: 'none', ignoreRestSiblings: true }] },
	},
	{
		// The harness asserts the probe's stdout record.
		files: ['tests/integration/fixtures/extensions/hooks/config-schema-accountability-probe/index.js'],
		rules: { 'no-console': 'off' },
	},
	prettierConfig,
	{
		files: codeFiles,
		// eslint-plugin-prettier 4 calls context methods that ESLint 10 removed.
		plugins: { prettier: fixupPluginRules(prettierPlugin) },
		rules: { 'prettier/prettier': 'error' },
	},
]);
