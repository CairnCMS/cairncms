import { describe, expect, it } from 'vitest';
import type { ConfigManifest } from '../../types/config.js';
import { normalizeToInternal, serializeToWire } from './wire.js';

function manifest(version: 1 | 2, resources: ConfigManifest['resources']): ConfigManifest {
	return { version, resources };
}

describe('normalizeToInternal', () => {
	it('keeps managed records and empties every other kind', () => {
		const config = normalizeToInternal(manifest(1, ['roles']), {
			roles: [{ key: 'editor' }],
			permissions: [{ role: 'editor' }],
			folders: [{ key: 'docs' }],
		});

		expect(config.roles).toEqual([{ key: 'editor' }]);
		expect(config.permissions).toEqual([]);
		expect(config.folders).toEqual([]);
	});

	it('fills an absent managed array as empty', () => {
		const config = normalizeToInternal(manifest(2, ['folders']), {});

		expect(config.roles).toEqual([]);
		expect(config.permissions).toEqual([]);
		expect(config.folders).toEqual([]);
	});
});

describe('serializeToWire', () => {
	const complete = {
		manifest: manifest(2, ['roles', 'folders']),
		roles: [{ key: 'editor' }] as never,
		permissions: [] as never,
		folders: [{ key: 'docs' }] as never,
		settings: [] as never,
	};

	it('drops out-of-version kinds for a version-1 wire body', () => {
		const wire = serializeToWire({ ...complete, manifest: manifest(1, ['roles']) }, 1);

		expect(wire).toHaveProperty('roles');
		expect(wire).toHaveProperty('permissions');
		expect(wire).not.toHaveProperty('folders');
	});

	it('keeps folders for a version-2 wire body', () => {
		const wire = serializeToWire(complete, 2);

		expect(wire).toHaveProperty('folders', complete.folders);
	});

	it('leaves record contents untouched', () => {
		const wire = serializeToWire(complete, 2);

		expect(wire['roles']).toBe(complete.roles);
	});
});
