import type { CairnConfig } from '../types/config.js';

export function configFixture(overrides: Partial<CairnConfig> & Pick<CairnConfig, 'manifest'>): CairnConfig {
	return {
		roles: [],
		permissions: [],
		folders: [],
		settings: [],
		'extension-settings': [],
		translations: [],
		schema: [],
		...overrides,
	};
}
