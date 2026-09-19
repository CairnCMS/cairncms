import { describe, expect, it } from 'vitest';
import { ConfigUnsupportedVersionException } from '../../exceptions/config-unsupported-version.js';
import { validateConfigManifest, validateDesiredConfig } from '../validate-desired-config.js';
import { kindsForVersion } from './registry.js';

const CTX = {
	label: 'test',
	references: 'current-state',
	currentRoleKeys: new Set<string>(),
	currentFolderKeys: new Set<string>(),
	currentFolderParents: new Map<string, string | null>(),
} as const;

describe('kindsForVersion', () => {
	it('excludes folders at version 1 and includes it at version 2', () => {
		expect(kindsForVersion(1)).toEqual(['roles', 'permissions']);
		expect(kindsForVersion(2)).toEqual(['roles', 'permissions', 'folders', 'settings', 'extension-settings']);
	});
});

describe('validateConfigManifest version gate', () => {
	it('rejects a version-1 manifest that names folders', () => {
		expect(() => validateConfigManifest({ version: 1, resources: ['folders'] }, 'test')).toThrow(
			ConfigUnsupportedVersionException
		);
	});

	it('accepts a version-2 manifest that names folders', () => {
		expect(validateConfigManifest({ version: 2, resources: ['folders'] }, 'test')).toMatchObject({
			version: 2,
			resources: ['folders'],
		});
	});

	it('rejects a version-1 manifest that names settings', () => {
		expect(() => validateConfigManifest({ version: 1, resources: ['settings'] }, 'test')).toThrow(
			ConfigUnsupportedVersionException
		);
	});

	it('accepts a version-2 manifest that names settings', () => {
		expect(validateConfigManifest({ version: 2, resources: ['settings'] }, 'test')).toMatchObject({
			version: 2,
			resources: ['settings'],
		});
	});

	it('accepts a version-1 manifest naming only version-1 kinds', () => {
		expect(validateConfigManifest({ version: 1, resources: ['roles', 'permissions'] }, 'test')).toMatchObject({
			version: 1,
		});
	});
});

describe('validateDesiredConfig folder version boundary', () => {
	it('accepts a version-1 body that omits folders', () => {
		const body = { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [] };
		expect(validateDesiredConfig(body, CTX)).toEqual([]);
	});

	it('rejects a version-1 body that carries a folders key', () => {
		const body = { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [], folders: [] };
		expect(validateDesiredConfig(body, CTX).length).toBeGreaterThan(0);
	});

	it('requires a folders array in a version-2 body', () => {
		const body = { manifest: { version: 2, resources: ['roles'] }, roles: [], permissions: [] };
		expect(validateDesiredConfig(body, CTX).length).toBeGreaterThan(0);
	});

	it('accepts a version-2 roles-only body that carries an empty folders array', () => {
		const body = {
			manifest: { version: 2, resources: ['roles'] },
			roles: [],
			permissions: [],
			folders: [],
			settings: [],
			'extension-settings': [],
		};

		expect(validateDesiredConfig(body, CTX)).toEqual([]);
	});

	it('accepts a non-empty unmanaged folders array without validating its records', () => {
		const body = {
			manifest: { version: 2, resources: ['roles'] },
			roles: [],
			permissions: [],
			folders: [{ garbage: true }],
			settings: [],
			'extension-settings': [],
		};

		expect(validateDesiredConfig(body, CTX)).toEqual([]);
	});

	it('validates a managed folders tree and rejects a duplicate key', () => {
		const body = {
			manifest: { version: 2, resources: ['folders'] },
			roles: [],
			permissions: [],
			settings: [],
			'extension-settings': [],
			folders: [
				{ key: 'docs', name: 'Docs' },
				{ key: 'docs', name: 'Docs Two' },
			],
		};

		expect(validateDesiredConfig(body, CTX).some((failure) => failure.code === 'CONFIG_IDENTITY_CONFLICT')).toBe(true);
	});
});
