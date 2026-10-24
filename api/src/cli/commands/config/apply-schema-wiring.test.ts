import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaReadFixture } from '../../../__utils__/config-fixtures.js';
import type { CairnConfig, ConfigSchemaCollection } from '../../../types/config.js';
import type { SnapshotField } from '../../../types/index.js';

const { envOverrides } = vi.hoisted(() => ({ envOverrides: {} as Record<string, unknown> }));

vi.mock('../../../env.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../env.js')>();

	const proxy = new Proxy(actual.default, {
		get(target, prop) {
			return prop in envOverrides ? envOverrides[prop as string] : Reflect.get(target, prop);
		},
	});

	return { ...actual, default: proxy, getEnv: () => proxy };
});

vi.mock('../../../database/index.js', () => ({
	default: vi.fn(() => ({ destroy: vi.fn() })),
	isInstalled: vi.fn(async () => true),
	hasDatabaseConnection: vi.fn(async () => true),
	getDatabaseClient: () => 'postgres',
}));

vi.mock('../../../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock('../../../utils/read-config-directory.js', () => ({
	readConfigDirectory: vi.fn(),
	isPlaceholder: vi.fn(() => false),
}));

vi.mock('../../../utils/get-config-snapshot.js', () => ({ readCurrentConfig: vi.fn() }));

vi.mock('../../../utils/apply-folder-preparation.js', () => ({ applyFolderPreparation: vi.fn() }));

vi.mock('../../../utils/get-schema.js', () => ({ getSchema: vi.fn(async () => ({ collections: {} })) }));

vi.mock('../../../utils/folder-references.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../utils/folder-references.js')>()),
	readFolderKeys: vi.fn(async () => ({
		folderIdByKey: new Map<string, string>(),
		folderKeyById: new Map<string, string>(),
	})),
}));

vi.mock('../../../extensions.js', () => ({
	getExtensionManager: () => ({
		isSettingsDiscoveryComplete: () => true,
		getSettingsOwners: () => [
			{
				status: 'available',
				subject: '@cairncms/extension-widget',
				declaration: { label: { type: 'string', scope: 'collection' } },
			},
		],
	}),
}));

import logger from '../../../logger.js';
import { applyFolderPreparation } from '../../../utils/apply-folder-preparation.js';
import { readCurrentConfig, type CurrentConfigRead } from '../../../utils/get-config-snapshot.js';
import { readConfigDirectory } from '../../../utils/read-config-directory.js';
import { version } from '../../../utils/package.js';
import { configApply } from './apply.js';

const STORED_MARKER = 'PRIVATE_STORED_MARKER';

function desired(): CairnConfig {
	return {
		manifest: { version: 3, resources: ['schema'], schema: { release: version, vendor: 'postgres' } },
		roles: [],
		permissions: [],
		folders: [],
		settings: [],
		'extension-settings': [],
		translations: [],
		schema: [
			{
				collection: 'articles',
				meta: {} as Exclude<ConfigSchemaCollection['meta'], undefined>,
				schema: { name: 'articles' } as Exclude<ConfigSchemaCollection['schema'], undefined>,
				fields: [
					{
						collection: 'articles',
						field: 'title',
						type: 'string',
						meta: {},
						schema: { name: 'title' },
					} as unknown as SnapshotField,
				],
				relations: [],
			},
		],
	};
}

function currentRead(withStoredFields: boolean): CurrentConfigRead {
	return {
		config: {
			manifest: { version: 3, resources: ['schema'] },
			roles: [],
			permissions: [],
			folders: [],
			settings: [],
			'extension-settings': [],
			translations: [],
			schema: [],
		},
		currentRoleKeys: new Set<string>(),
		currentFolderKeys: new Set<string>(),
		currentFolderParents: new Map<string, string | null>(),
		stateToken: { resources: ['schema'], digest: 'digest' },
		...(withStoredFields && storedRead()),
	};
}

function storedRead() {
	const stored = [
		{ collection: STORED_MARKER, field: 'secret', type: 'string', meta: {}, schema: { name: 'secret' } } as never,
	];

	const { capture } = schemaReadFixture([]);

	return {
		schemaStoredFields: stored,
		schemaCapture: { ...capture, snapshot: { ...capture.snapshot, fields: stored } },
	};
}

const ID_FIELD = {
	collection: 'articles',
	field: 'id',
	type: 'integer',
	meta: {},
	schema: { name: 'id', is_primary_key: true },
} as unknown as SnapshotField;

function readWithTitle() {
	const record = desired().schema[0]!;
	const read = schemaReadFixture([{ ...record, fields: [ID_FIELD, ...record.fields] }]);
	const base = currentRead(false);

	return {
		...base,
		config: { ...base.config, schema: read.records },
		schemaStoredFields: read.storedFields,
		schemaCapture: read.capture,
	};
}

let writes: string[];
let exitCode: number | undefined;

beforeEach(() => {
	writes = [];
	exitCode = undefined;

	vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
		writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
		return true;
	});

	vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		exitCode = code;
		return undefined as never;
	}) as never);

	vi.mocked(readConfigDirectory).mockResolvedValue(desired());
	vi.mocked(readCurrentConfig).mockResolvedValue(currentRead(true) as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('configApply schema wiring', () => {
	it('serializes a version 3 schema dry run through the real pipeline and excludes the private capture', async () => {
		await configApply('./config', { format: 'json', dryRun: true, destructive: false, yes: true });

		expect(exitCode).toBe(1);

		const output = writes.join('');
		const serialized = JSON.parse(output);

		expect(serialized.planVersion).toBe(3);

		const kinds = serialized.changes.map((change: { kind: string }) => change.kind);
		expect(kinds).toContain('collections');
		expect(kinds).toContain('fields');

		expect(output).not.toContain(STORED_MARKER);
	});

	it('admits a collection-scoped extension setting for a collection the schema plan creates', async () => {
		const tree = desired();

		tree.manifest = {
			version: 3,
			resources: ['extension-settings', 'schema'],
			schema: { release: version, vendor: 'postgres' },
		};

		tree.schema[0]!.fields.push({
			collection: 'articles',
			field: 'id',
			type: 'integer',
			meta: {},
			schema: { name: 'id', is_primary_key: true },
		} as unknown as SnapshotField);

		tree['extension-settings'] = [
			{ subject: '@cairncms/extension-widget', global: {}, collections: { articles: { label: 'x' } } },
		];

		vi.mocked(readConfigDirectory).mockResolvedValue(tree);

		await configApply('./config', { format: 'json', dryRun: true, destructive: false, yes: true });

		expect(exitCode).toBe(1);

		const kinds = JSON.parse(writes.join('')).changes.map((change: { kind: string }) => change.kind);
		expect(kinds).toContain('extension-settings');
	});

	it('fails a version 3 dry run when the private capture was not forwarded', async () => {
		vi.mocked(readCurrentConfig).mockResolvedValue(currentRead(false) as never);

		await configApply('./config', { format: 'json', dryRun: true, destructive: false, yes: true });

		expect(exitCode).toBe(3);
	});

	it.each([
		['a JSON dry run', { format: 'json', dryRun: true }],
		['a human dry run', { format: 'human', dryRun: true }],
		['an apply', { format: 'human', dryRun: false }],
	])('refuses a schema change the read cannot take in %s, before preparing folders', async (_label, options) => {
		vi.mocked(readCurrentConfig).mockResolvedValue(readWithTitle());

		const tree = desired();
		const title = { ...tree.schema[0]!.fields[0]! } as Partial<SnapshotField>;
		delete title.schema;
		tree.schema[0]!.fields = [ID_FIELD, title as SnapshotField];
		vi.mocked(readConfigDirectory).mockResolvedValue(tree);

		await configApply('./config', { destructive: false, yes: true, ...options });

		expect(exitCode).toBe(2);
		expect(writes.join('')).toBe('');
		expect(applyFolderPreparation).not.toHaveBeenCalled();

		expect(vi.mocked(logger.error).mock.calls.flat().map(String).join('\n')).toContain(
			`can't remove its column and remain as a field.`
		);
	});
});
