import type { DeepPartial } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { ConfigProtectedRecordException } from '../../exceptions/config-protected-record.js';
import { ConfigSchemaSourceException } from '../../exceptions/config-schema-source.js';
import { DestructiveChangesRequiredException } from '../../exceptions/destructive-changes-required.js';
import type { ConfigKind, ConfigManifest, ConfigPlan, SchemaChangeEntry } from '../../types/config.js';
import type { SnapshotField } from '../../types/index.js';
import { listConfigKinds } from './registry.js';
import { assertMutationAuthorized, assertRunValid } from './run-preflight.js';

const currentRelease = '1.7.0';
const currentVendor = 'postgres';

function plan(managedResources: ConfigKind[], overrides: Partial<ConfigPlan> = {}): ConfigPlan {
	const slices = Object.fromEntries(
		listConfigKinds().map((kind) => [kind, { create: [], update: [], delete: [] }])
	) as unknown as Pick<ConfigPlan, ConfigKind>;

	return { ...slices, managedResources, protections: [], ...overrides };
}

function manifestFor(resources: ConfigKind[], schema?: { release: string; vendor: string }): ConfigManifest {
	if (!resources.includes('schema')) return { version: 3, resources };

	return { version: 3, resources, schema: schema ?? { release: currentRelease, vendor: currentVendor } };
}

function field(name: string, meta: DeepPartial<SnapshotField['meta']>): SnapshotField {
	const draft: DeepPartial<SnapshotField> = { collection: 'articles', field: name, type: 'uuid', schema: null, meta };
	return draft as SnapshotField;
}

function fileField(folder: unknown, name = 'cover'): SnapshotField {
	return field(name, { interface: 'file', options: { folder } });
}

type ValidityOverrides = Partial<Parameters<typeof assertRunValid>[0]>;

function validity(overrides: ValidityOverrides = {}): void {
	assertRunValid({
		manifest: overrides.manifest ?? manifestFor(['schema', 'folders']),
		forceSchema: false,
		currentRelease,
		currentVendor,
		schemaFields: [],
		availableFolderKeys: new Map<string, string>(),
		...overrides,
	});
}

describe('assertRunValid', () => {
	it('passes a clean run', () => {
		expect(() => validity()).not.toThrow();
	});

	it('refuses a source mismatch, and the override permits it', () => {
		const manifest = manifestFor(['schema'], { release: '1.6.0', vendor: currentVendor });
		expect(() => validity({ manifest })).toThrow(ConfigSchemaSourceException);
		expect(() => validity({ manifest, forceSchema: true })).not.toThrow();
	});

	it('refuses a managed-schema run with no recorded provenance', () => {
		expect(() => validity({ manifest: { version: 3, resources: ['schema'] } })).toThrow(ConfigSchemaSourceException);
	});

	it('refuses an unmet folder reference and names the folder', () => {
		expect(() => validity({ schemaFields: [fileField('ghost')] })).toThrow(ConfigInvalidException);
		expect(() => validity({ schemaFields: [fileField('ghost')] })).toThrow(/ghost/);
	});

	it('refuses a folder reference whose value is not a folder key', () => {
		expect(() => validity({ schemaFields: [fileField(123)] })).toThrow(ConfigInvalidException);
	});

	it('sanitizes control characters from the reference refusal message', () => {
		const bel = String.fromCharCode(7);
		let message: string | undefined;

		try {
			validity({ schemaFields: [fileField(123, `cover${bel}`)] });
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain('not a folder key');
		expect(Array.from(message ?? '').some((char) => char.charCodeAt(0) < 0x20)).toBe(false);
	});

	it('passes references to folders present on the target or declared and preparable', () => {
		expect(() =>
			validity({
				schemaFields: [fileField('present', 'cover_a'), fileField('declared', 'cover_b')],
				availableFolderKeys: new Map([
					['present', 'folder-id'],
					['declared', 'declared'],
				]),
			})
		).not.toThrow();
	});
});

describe('assertMutationAuthorized', () => {
	const folderDeletion = plan(['folders'], { folders: { create: [], update: [], delete: ['uploads'] } });

	const schemaDrop: SchemaChangeEntry = {
		changeKind: 'collections',
		identity: { collection: 'legacy_posts' },
		changes: {},
	};

	const schemaDeletion = plan(['schema'], { schema: { create: [], update: [], delete: [schemaDrop] } });

	const adminProtection = plan(['roles'], {
		protections: [{ code: 'ADMIN_CONTINUITY_REQUIRED', message: 'Keep an admin role.', contributors: [] }],
	});

	it('passes a clean plan', () => {
		expect(() => assertMutationAuthorized(plan(['roles']), false)).not.toThrow();
	});

	it('refuses a protected plan', () => {
		expect(() => assertMutationAuthorized(adminProtection, false)).toThrow(ConfigProtectedRecordException);
	});

	it('refuses a deletion plan without destructive, and allows it with destructive', () => {
		expect(() => assertMutationAuthorized(folderDeletion, false)).toThrow(DestructiveChangesRequiredException);
		expect(() => assertMutationAuthorized(folderDeletion, true)).not.toThrow();
	});

	it('reports a schema collection deletion rather than throwing an unsupported planning error', () => {
		let thrown: unknown;

		try {
			assertMutationAuthorized(schemaDeletion, false);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(DestructiveChangesRequiredException);

		expect((thrown as DestructiveChangesRequiredException).extensions).toMatchObject({
			deletions: [{ kind: 'schema', identity: { collection: 'legacy_posts' } }],
		});
	});
});
