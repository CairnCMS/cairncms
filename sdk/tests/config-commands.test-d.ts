import { assertType, describe, expectTypeOf, it } from 'vitest';
import { configApply, configSnapshot, createCairnCMS, rest, schemaApply, schemaDiff } from '../src/index.js';
import type {
	ConfigApplyOutput,
	ConfigDocument,
	ConfigDocumentLatest,
	ConfigDocumentV1,
	ConfigDocumentV2,
	ConfigDocumentV3,
	ConfigKindV1,
	ConfigKindV2,
	ConfigKindV3,
	ConfigPlanOutput,
	ConfigSnapshotOptions,
	SchemaDiffOutput,
	SchemaSnapshotV2Output,
} from '../src/index.js';

type Records = Record<string, any>[];

const client = createCairnCMS('http://localhost:8055').with(rest());

const v3: ConfigDocumentV3 = {
	manifest: { version: 3, resources: ['schema'] },
	roles: [],
	permissions: [],
	folders: [],
	settings: [],
	'extension-settings': [],
	translations: [],
	schema: [],
};

describe('config command types', () => {
	it('types a dry run as the plan and an apply as the data and meta envelope', () => {
		const dryRun = () => client.request(configApply(v3, { dryRun: true }));
		const apply = () => client.request(configApply(v3));
		const explicitApply = () => client.request(configApply(v3, { dryRun: false, destructive: true }));

		expectTypeOf(dryRun).returns.resolves.toEqualTypeOf<ConfigPlanOutput>();
		expectTypeOf(apply).returns.resolves.toEqualTypeOf<ConfigApplyOutput>();
		expectTypeOf(explicitApply).returns.resolves.toEqualTypeOf<ConfigApplyOutput>();
	});

	it('types an apply whose dry run is only known at runtime as either output', () => {
		const either = (dryRun: boolean) => client.request(configApply(v3, { dryRun }));

		expectTypeOf(either).returns.resolves.toEqualTypeOf<ConfigPlanOutput | ConfigApplyOutput>();
	});

	it('types an unversioned snapshot as the latest document with every known array', () => {
		const latest = () => client.request(configSnapshot());
		const scoped = () => client.request(configSnapshot({ resources: ['schema'] }));

		expectTypeOf(latest).returns.resolves.toEqualTypeOf<ConfigDocumentLatest>();
		expectTypeOf(scoped).returns.resolves.toEqualTypeOf<ConfigDocumentLatest>();

		const snapshot = {} as ConfigDocumentLatest;

		expectTypeOf(snapshot.manifest).toEqualTypeOf<{
			version: number;
			resources: string[];
			schema?: { release: string; vendor: string };
		}>();

		expectTypeOf<
			Pick<
				ConfigDocumentLatest,
				'roles' | 'permissions' | 'folders' | 'settings' | 'extension-settings' | 'translations' | 'schema'
			>
		>().toEqualTypeOf<
			Record<
				'roles' | 'permissions' | 'folders' | 'settings' | 'extension-settings' | 'translations' | 'schema',
				Records
			>
		>();

		const roleCount = (document: ConfigDocumentLatest) => document.roles.length;

		expectTypeOf(roleCount).returns.toEqualTypeOf<number>();
	});

	it('keeps the exact types of a version 1, 2 or 3 snapshot', () => {
		const version1 = () => client.request(configSnapshot({ manifestVersion: 1 }));
		const version2 = () => client.request(configSnapshot({ manifestVersion: 2 }));
		const version3 = () => client.request(configSnapshot({ manifestVersion: 3, resources: ['schema'] }));
		const legacyVersion = (manifestVersion: 1 | 2 | 3) => client.request(configSnapshot({ manifestVersion }));

		expectTypeOf(version1).returns.resolves.toEqualTypeOf<ConfigDocumentV1>();
		expectTypeOf(version2).returns.resolves.toEqualTypeOf<ConfigDocumentV2>();
		expectTypeOf(version3).returns.resolves.toEqualTypeOf<ConfigDocumentV3>();
		expectTypeOf(legacyVersion).returns.resolves.toEqualTypeOf<ConfigDocument>();
	});

	it('types any other requested version as a legacy or latest document', () => {
		const version4 = () => client.request(configSnapshot({ manifestVersion: 4 }));
		const runtimeVersion = (manifestVersion: number) => client.request(configSnapshot({ manifestVersion }));
		const fromOptions = (options: ConfigSnapshotOptions) => client.request(configSnapshot(options));

		expectTypeOf(version4).returns.resolves.toEqualTypeOf<ConfigDocument | ConfigDocumentLatest>();
		expectTypeOf(runtimeVersion).returns.resolves.toEqualTypeOf<ConfigDocument | ConfigDocumentLatest>();
		expectTypeOf(fromOptions).returns.resolves.toEqualTypeOf<ConfigDocument | ConfigDocumentLatest>();
	});

	it('requires a check before using an array a runtime-selected version may lack', () => {
		const snapshot = {} as ConfigDocument | ConfigDocumentLatest;

		// @ts-expect-error a version 1 or 2 document has no schema array
		void snapshot.schema;

		if ('schema' in snapshot) expectTypeOf(snapshot.schema).toEqualTypeOf<Records>();
	});

	it('keeps an authored legacy document and an exhaustive legacy consumer compiling', () => {
		const authored: ConfigDocument = {
			manifest: { version: 1, resources: ['roles'] },
			roles: [],
			permissions: [],
		};

		const versionOf = (document: ConfigDocument): 1 | 2 | 3 => document.manifest.version;

		expectTypeOf(versionOf(authored)).toEqualTypeOf<1 | 2 | 3>();
	});

	it('accepts an authored latest document with a kind this SDK release does not know', () => {
		const authored: ConfigDocumentLatest = {
			manifest: { version: 5, resources: ['roles', 'flows'] },
			roles: [],
			permissions: [],
			folders: [],
			settings: [],
			'extension-settings': [],
			translations: [],
			schema: [],
			flows: [{ name: 'Nightly export' }],
		};

		expectTypeOf(authored['flows']).toEqualTypeOf<unknown>();
		assertType<ConfigDocumentLatest>(v3);
	});

	it('keeps the version 1, 2 and 3 types and the snapshot options as shipped', () => {
		expectTypeOf<ConfigKindV1>().toEqualTypeOf<'roles' | 'permissions'>();

		expectTypeOf<ConfigKindV2>().toEqualTypeOf<
			'roles' | 'permissions' | 'folders' | 'settings' | 'extension-settings' | 'translations'
		>();

		expectTypeOf<ConfigKindV3>().toEqualTypeOf<
			'roles' | 'permissions' | 'folders' | 'settings' | 'extension-settings' | 'translations' | 'schema'
		>();

		expectTypeOf<ConfigDocumentV1>().toEqualTypeOf<{
			manifest: { version: 1; resources: ConfigKindV1[] };
			roles: Records;
			permissions: Records;
		}>();

		expectTypeOf<ConfigDocumentV2>().toEqualTypeOf<{
			manifest: { version: 2; resources: ConfigKindV2[] };
			roles: Records;
			permissions: Records;
			folders: Records;
			settings: Records;
			'extension-settings': Records;
			translations: Records;
		}>();

		expectTypeOf<ConfigDocumentV3>().toEqualTypeOf<{
			manifest: { version: 3; resources: ConfigKindV3[]; schema?: { release: string; vendor: string } };
			roles: Records;
			permissions: Records;
			folders: Records;
			settings: Records;
			'extension-settings': Records;
			translations: Records;
			schema: Records;
		}>();

		expectTypeOf<ConfigDocument>().toEqualTypeOf<ConfigDocumentV1 | ConfigDocumentV2 | ConfigDocumentV3>();
		expectTypeOf<ConfigSnapshotOptions>().toEqualTypeOf<{ manifestVersion?: 1 | 2 | 3; resources?: ConfigKindV3[] }>();
	});

	it('does not promise arrays a manifest version lacks', () => {
		const v1 = {} as ConfigDocumentV1;
		const v2 = {} as ConfigDocumentV2;

		// @ts-expect-error a version 1 document has no folders array
		void v1.folders;

		// @ts-expect-error a version 2 document has no schema array
		void v2.schema;

		expectTypeOf(v2.folders).toEqualTypeOf<Record<string, any>[]>();
		expectTypeOf(v3.schema).toEqualTypeOf<Record<string, any>[]>();
	});

	it('accepts any manifest version of document in configApply', () => {
		configApply({} as ConfigDocumentV1);
		configApply({} as ConfigDocumentV2);
		configApply({} as ConfigDocument, { dryRun: true });
		configApply({} as ConfigDocumentLatest);
		configApply({} as ConfigDocument | ConfigDocumentLatest, { dryRun: true });
	});

	it('keeps the deprecated schemaDiff and schemaApply commands typed during the notice period', () => {
		const diff = (snapshot: SchemaSnapshotV2Output) => client.request(schemaDiff(snapshot, true));
		const apply = (output: SchemaDiffOutput) => client.request(schemaApply(output));

		expectTypeOf(diff).returns.resolves.toEqualTypeOf<SchemaDiffOutput>();
		expectTypeOf(apply).returns.resolves.toEqualTypeOf<void>();
	});
});
