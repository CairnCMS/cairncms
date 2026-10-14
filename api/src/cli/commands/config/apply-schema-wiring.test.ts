import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
}));

vi.mock('../../../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock('../../../utils/read-config-directory.js', () => ({
	readConfigDirectory: vi.fn(),
	isPlaceholder: vi.fn(() => false),
}));

vi.mock('../../../utils/get-config-snapshot.js', () => ({ readCurrentConfig: vi.fn() }));

vi.mock('../../../utils/get-schema.js', () => ({ getSchema: vi.fn(async () => ({ collections: {} })) }));

vi.mock('../../../extensions.js', () => ({
	getExtensionManager: () => ({ isSettingsDiscoveryComplete: () => true, getSettingsOwners: () => [] }),
}));

import { readCurrentConfig } from '../../../utils/get-config-snapshot.js';
import { readConfigDirectory } from '../../../utils/read-config-directory.js';
import { configApply } from './apply.js';

const STORED_MARKER = 'PRIVATE_STORED_MARKER';

function desired(): CairnConfig {
	return {
		manifest: { version: 3, resources: ['schema'] },
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

function currentRead(withStoredFields: boolean) {
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
		...(withStoredFields && {
			schemaStoredFields: [
				{ collection: STORED_MARKER, field: 'secret', type: 'string', meta: {}, schema: { name: 'secret' } } as never,
			],
		}),
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

	it('fails a version 3 dry run when the private capture was not forwarded', async () => {
		vi.mocked(readCurrentConfig).mockResolvedValue(currentRead(false) as never);

		await configApply('./config', { format: 'json', dryRun: true, destructive: false, yes: true });

		expect(exitCode).toBe(3);
	});
});
