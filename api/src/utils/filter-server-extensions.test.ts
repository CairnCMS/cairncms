import type { Extension } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import { filterServerExtensions } from './filter-server-extensions.js';

const base = { path: '/ext', local: false };

const plainHook: Extension = { ...base, name: 'plain-hook', type: 'hook', entrypoint: 'index.js' };
const plainEndpoint: Extension = { ...base, name: 'plain-endpoint', type: 'endpoint', entrypoint: 'index.js' };

const confinedEndpoint: Extension = {
	...base,
	name: 'confined-endpoint',
	type: 'endpoint',
	entrypoint: 'index.js',
	runtime: 'confined-server',
};

const confinedOperation: Extension = {
	...base,
	name: 'confined-operation',
	type: 'operation',
	entrypoint: { app: 'app.js', api: 'api.js' },
	runtime: 'confined-server',
};

const plainBundle: Extension = {
	...base,
	name: 'plain-bundle',
	type: 'bundle',
	entrypoint: { app: 'app.js', api: 'api.js' },
	entries: [{ name: 'my-endpoint', type: 'endpoint' }],
};

const confinedBundle: Extension = {
	...base,
	name: 'confined-bundle',
	type: 'bundle',
	entrypoint: { app: 'app.js', api: 'api.js' },
	entries: [{ name: 'my-endpoint', type: 'endpoint' }],
	runtime: 'confined-server',
};

const appInterface: Extension = { ...base, name: 'app-interface', type: 'interface', entrypoint: 'index.js' };

describe('filterServerExtensions', () => {
	it('excludes confined server extensions from the full-authority path', () => {
		const names = filterServerExtensions([plainHook, confinedEndpoint, confinedOperation]).map(
			(extension) => extension.name
		);

		expect(names).toContain('plain-hook');
		expect(names).not.toContain('confined-endpoint');
		expect(names).not.toContain('confined-operation');
	});

	it('excludes a confined bundle and keeps a plain bundle', () => {
		const names = filterServerExtensions([plainBundle, confinedBundle]).map((extension) => extension.name);

		expect(names).toContain('plain-bundle');
		expect(names).not.toContain('confined-bundle');
	});

	it('passes app-only extensions through untouched', () => {
		expect(filterServerExtensions([appInterface]).map((extension) => extension.name)).toContain('app-interface');
	});

	it('keeps every plain extension', () => {
		expect(filterServerExtensions([plainHook, plainEndpoint, plainBundle, appInterface])).toHaveLength(4);
	});
});
