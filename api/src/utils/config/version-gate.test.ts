import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { ConfigUnsupportedVersionException } from '../../exceptions/config-unsupported-version.js';
import { buildRecordSchemas, validateConfigManifest, validateDesiredConfig } from '../validate-desired-config.js';
import type { ConfigFieldDescriptor } from './descriptor.js';
import { CONFIG_REGISTRY, kindsForVersion } from './registry.js';

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

		expect(kindsForVersion(2)).toEqual([
			'roles',
			'permissions',
			'folders',
			'settings',
			'extension-settings',
			'translations',
		]);
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

	it('rejects a version-1 manifest that names translations', () => {
		expect(() => validateConfigManifest({ version: 1, resources: ['translations'] }, 'test')).toThrow(
			ConfigUnsupportedVersionException
		);
	});

	it('accepts a version-2 manifest that names translations', () => {
		expect(validateConfigManifest({ version: 2, resources: ['translations'] }, 'test')).toMatchObject({
			version: 2,
			resources: ['translations'],
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

	it('rejects a version-1 body that carries a translations key', () => {
		const body = { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [], translations: [] };
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
			translations: [],
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
			translations: [],
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
			translations: [],
			folders: [
				{ key: 'docs', name: 'Docs' },
				{ key: 'docs', name: 'Docs Two' },
			],
		};

		expect(validateDesiredConfig(body, CTX).some((failure) => failure.code === 'CONFIG_IDENTITY_CONFLICT')).toBe(true);
	});
});

describe('field manifest version gate', () => {
	const real = CONFIG_REGISTRY.settings;
	const base = real.recordFields.find((field) => field.name === 'public_note')!;
	const gated: ConfigFieldDescriptor = { ...base, name: 'gated_note', formatVersion: 4 };
	const options = { convert: false, abortEarly: false } as const;

	beforeEach(() => {
		CONFIG_REGISTRY.settings = {
			...real,
			recordFields: [...real.recordFields, gated],
			valueFieldOrder: [...real.valueFieldOrder, gated.name],
		};
	});

	afterEach(() => {
		CONFIG_REGISTRY.settings = real;
	});

	function settingsBody(version: number, settings: Record<string, unknown>[], resources: string[] = ['settings']) {
		return {
			manifest: { version, resources },
			roles: [],
			permissions: [],
			folders: [],
			settings,
			'extension-settings': [],
			translations: [],
			...(version >= 3 && { schema: [] }),
		};
	}

	it('refuses a managed document that sets a field newer than its manifest version, naming the field and version', () => {
		const body = settingsBody(3, [{ gated_note: 'early' }]);

		expect(() => validateDesiredConfig(body, CTX)).toThrow(ConfigUnsupportedVersionException);

		expect(() => validateDesiredConfig(body, CTX)).toThrow(
			'declares version 3 but sets settings field gated_note (version 4)'
		);
	});

	it('leaves a newer field in an unmanaged kind to that kind', () => {
		expect(validateDesiredConfig(settingsBody(3, [{ gated_note: 'unmanaged' }], ['roles']), CTX)).toEqual([]);
	});

	it('builds schemas that refuse the field below its version and admit it from its version', () => {
		expect(buildRecordSchemas('authored', 3).settings.validate({ gated_note: 'x' }, options).error?.message).toContain(
			'"gated_note" is not allowed'
		);

		expect(buildRecordSchemas('authored', 4).settings.validate({ gated_note: 'x' }, options).error).toBeUndefined();
	});

	it('requires the field in a snapshot only from its version', () => {
		expect(buildRecordSchemas('snapshot', 3).settings.validate({}, options).error?.message).not.toContain('gated_note');

		expect(buildRecordSchemas('snapshot', 4).settings.validate({}, options).error?.message).toContain(
			'"gated_note" is required'
		);
	});
});

describe('schema provenance across manifest versions', () => {
	const provenance = { release: '1.8.0', vendor: 'postgres' };

	it('accepts provenance at version 4 when schema is managed', () => {
		expect(validateConfigManifest({ version: 4, resources: ['schema'], schema: provenance }, 'test')).toMatchObject({
			version: 4,
			schema: provenance,
		});
	});

	it('refuses provenance when schema is not managed', () => {
		expect(() => validateConfigManifest({ version: 4, resources: ['roles'], schema: provenance }, 'test')).toThrow(
			ConfigInvalidException
		);
	});
});
