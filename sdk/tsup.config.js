import { defineConfig } from 'tsup';
import { replace } from 'esbuild-plugin-replace';
import { systemCollectionNames } from './config/system-collection-names.js';

const env = process.env.NODE_ENV;

export default defineConfig(() => ({
	sourcemap: env === 'production',
	clean: true,
	dts: true,
	format: ['cjs', 'esm'],
	minify: env === 'production',
	watch: env === 'development',
	bundle: true,
	target: 'es2020',
	entry: ['src/index.ts'],
	esbuildPlugins: [
		replace({
			__SYSTEM_COLLECTION_NAMES__: JSON.stringify(systemCollectionNames),
		}),
	],
}));
