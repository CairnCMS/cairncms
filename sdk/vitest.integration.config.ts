import { defineConfig } from 'vitest/config';
import { systemCollectionNames } from './config/system-collection-names.js';

export default defineConfig({
	define: {
		// Tests run SDK source directly (not the bundled dist), so the
		// __SYSTEM_COLLECTION_NAMES__ placeholder — which tsup replaces at
		// build time via esbuild-plugin-replace — is undefined under vitest.
		// Declaring it here as a define makes it resolve at test time.
		__SYSTEM_COLLECTION_NAMES__: JSON.stringify(systemCollectionNames),
	},
	test: {
		include: ['tests/integration/**/*.test.ts'],
		globalSetup: './tests/integration/setup.ts',
		testTimeout: 30_000,
		hookTimeout: 90_000,
		// Integration tests run sequentially: one API subprocess, one DB
		fileParallelism: false,
	},
});
