import { describe, expect, it } from 'vitest';
import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { ConfigProtectedRecordException } from '../../exceptions/config-protected-record.js';
import { ConfigSchemaSourceException } from '../../exceptions/config-schema-source.js';
import { DestructiveChangesRequiredException } from '../../exceptions/destructive-changes-required.js';
import type { ConfigKind, ConfigManifest, ConfigPlan, SchemaChangeEntry } from '../../types/config.js';
import { listConfigKinds } from './registry.js';
import { assertRunAllowed } from './run-preflight.js';

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

type Overrides = Partial<Parameters<typeof assertRunAllowed>[0]>;

function run(overrides: Overrides = {}): void {
	const manifest = overrides.manifest ?? manifestFor(['folders']);

	assertRunAllowed({
		plan: plan(manifest.resources),
		dryRun: false,
		destructive: false,
		forceSchema: false,
		currentRelease,
		currentVendor,
		referencedFolderKeys: new Set(),
		declaredFolderKeys: new Set(),
		currentFolderKeys: new Set(),
		...overrides,
		manifest,
	});
}

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

describe('assertRunAllowed', () => {
	it('passes a clean mutating run', () => {
		expect(() => run()).not.toThrow();
	});

	it('refuses a folder deletion without destructive on a mutating run', () => {
		expect(() => run({ plan: folderDeletion })).toThrow(DestructiveChangesRequiredException);
	});

	it('previews a deletion plan in a dry run', () => {
		expect(() => run({ plan: folderDeletion, dryRun: true })).not.toThrow();
	});

	it('reports a schema collection deletion rather than throwing an unsupported planning error', () => {
		let thrown: unknown;

		try {
			run({ plan: schemaDeletion, manifest: manifestFor(['schema']) });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(DestructiveChangesRequiredException);

		expect((thrown as DestructiveChangesRequiredException).extensions).toMatchObject({
			deletions: [{ kind: 'schema', identity: { collection: 'legacy_posts' } }],
		});
	});

	it('refuses a protected plan on a mutating run', () => {
		expect(() => run({ plan: adminProtection, manifest: manifestFor(['roles']) })).toThrow(
			ConfigProtectedRecordException
		);
	});

	it('previews a protected plan in a dry run', () => {
		expect(() => run({ plan: adminProtection, manifest: manifestFor(['roles']), dryRun: true })).not.toThrow();
	});

	it('refuses an unmet folder reference and names the folder, on a mutating run and in a dry run', () => {
		const manifest = manifestFor(['schema', 'folders']);
		const referencedFolderKeys = new Set(['ghost']);
		expect(() => run({ manifest, referencedFolderKeys })).toThrow(ConfigInvalidException);
		expect(() => run({ manifest, referencedFolderKeys })).toThrow(/ghost/);
		expect(() => run({ manifest, referencedFolderKeys, dryRun: true })).toThrow(ConfigInvalidException);
	});

	it('passes a referenced folder that is present on the target or declared in the tree', () => {
		expect(() =>
			run({
				manifest: manifestFor(['schema', 'folders']),
				referencedFolderKeys: new Set(['present', 'declared']),
				currentFolderKeys: new Set(['present']),
				declaredFolderKeys: new Set(['declared']),
			})
		).not.toThrow();
	});

	it('refuses a source mismatch on a mutating run and in a dry run', () => {
		const manifest = manifestFor(['schema'], { release: '1.6.0', vendor: currentVendor });
		expect(() => run({ manifest })).toThrow(ConfigSchemaSourceException);
		expect(() => run({ manifest, dryRun: true })).toThrow(ConfigSchemaSourceException);
	});

	it('lets the schema override pass a source mismatch', () => {
		const manifest = manifestFor(['schema'], { release: '1.6.0', vendor: 'mysql' });
		expect(() => run({ manifest, forceSchema: true })).not.toThrow();
	});
});
