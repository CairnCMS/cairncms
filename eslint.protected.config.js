const { defineConfig } = require('eslint/config');
const comments = require('@eslint-community/eslint-plugin-eslint-comments');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const vueParser = require('vue-eslint-parser');
const main = require('./eslint.config.js');

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
]);
