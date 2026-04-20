import { defineConfig } from 'vitest/config';
import { systemCollectionNames } from './config/system-collection-names.js';

/**
 * Default vitest config — runs type-level tests only.
 *
 * Integration tests have their own config at vitest.integration.config.ts
 * (they need a live API subprocess and globalSetup wiring), so we scope this
 * default to `tests/*.test-d.ts` to avoid picking them up and failing with
 * "Invalid URL" because globalSetup isn't running.
 */
export default defineConfig({
	define: {
		__SYSTEM_COLLECTION_NAMES__: JSON.stringify(systemCollectionNames),
	},
	test: {
		include: ['tests/*.test-d.ts'],
	},
});
