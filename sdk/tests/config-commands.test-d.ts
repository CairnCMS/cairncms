import { describe, expectTypeOf, it } from 'vitest';
import { configApply, configSnapshot, createCairnCMS, rest, schemaApply, schemaDiff } from '../src/index.js';
import type {
	ConfigApplyOutput,
	ConfigDocument,
	ConfigDocumentV1,
	ConfigDocumentV2,
	ConfigDocumentV3,
	ConfigPlanOutput,
	SchemaDiffOutput,
	SchemaSnapshotV2Output,
} from '../src/index.js';

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

	it('types a snapshot by its manifest version, defaulting to version 3', () => {
		const latest = () => client.request(configSnapshot());
		const version1 = () => client.request(configSnapshot({ manifestVersion: 1 }));
		const version2 = () => client.request(configSnapshot({ manifestVersion: 2 }));
		const anyVersion = (manifestVersion: 1 | 2 | 3) => client.request(configSnapshot({ manifestVersion }));

		expectTypeOf(latest).returns.resolves.toEqualTypeOf<ConfigDocumentV3>();
		expectTypeOf(version1).returns.resolves.toEqualTypeOf<ConfigDocumentV1>();
		expectTypeOf(version2).returns.resolves.toEqualTypeOf<ConfigDocumentV2>();
		expectTypeOf(anyVersion).returns.resolves.toEqualTypeOf<ConfigDocument>();
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
	});

	it('keeps the deprecated schemaDiff and schemaApply commands typed during the notice period', () => {
		const diff = (snapshot: SchemaSnapshotV2Output) => client.request(schemaDiff(snapshot, true));
		const apply = (output: SchemaDiffOutput) => client.request(schemaApply(output));

		expectTypeOf(diff).returns.resolves.toEqualTypeOf<SchemaDiffOutput>();
		expectTypeOf(apply).returns.resolves.toEqualTypeOf<void>();
	});
});
