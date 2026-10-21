import { BaseException } from '@cairncms/exceptions';
import type { Knex } from 'knex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	ApplyResult,
	CairnConfig,
	ConfigApplySecurityContext,
	ConfigPlan,
	ConfigSchemaCollection,
	ConfigStateToken,
	SchemaPersistedState,
	SnapshotField,
} from '../../types/index.js';
import { configFixture } from '../../__utils__/config-fixtures.js';
import { applyConfigPlan } from '../apply-config-plan.js';
import { applyDiff } from '../apply-diff.js';
import { computeConfigPlan } from '../compute-config-plan.js';
import { readFolderKeys } from '../folder-references.js';
import { readCurrentConfig } from '../get-config-snapshot.js';
import {
	applyConfigurationStep,
	applySchemaStep,
	computeWholeRunInputs,
	failureDetail,
	failureStatus,
} from './apply-steps.js';
import { computeSchemaDiff } from './handlers/schema.js';

vi.mock('../apply-diff.js', () => ({ applyDiff: vi.fn() }));
vi.mock('../get-config-snapshot.js', () => ({ readCurrentConfig: vi.fn() }));
vi.mock('../compute-config-plan.js', () => ({ computeConfigPlan: vi.fn() }));
vi.mock('../apply-config-plan.js', () => ({ applyConfigPlan: vi.fn() }));
vi.mock('../get-schema.js', () => ({ getSchema: vi.fn(async () => ({ collections: {} })) }));

vi.mock('../folder-references.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../folder-references.js')>()),
	readFolderKeys: vi.fn(),
}));

// Keep the real isPlanEmpty, so the plan fixtures decide the branch. Preserve each handler module's real exports so the
// registry isPlanEmpty walks still builds, overriding only the function this suite drives.
vi.mock('./handlers/schema.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./handlers/schema.js')>()),
	computeSchemaDiff: vi.fn(),
}));

vi.mock('./handlers/extension-settings.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./handlers/extension-settings.js')>()),
	buildExtensionDeclarationSnapshot: vi.fn(),
	desiredExtensionSubjects: vi.fn(),
}));

class Coded extends BaseException {
	constructor(code: string, extensions: Record<string, unknown> = {}) {
		super('message', 500, code, extensions);
	}
}

const persisted: SchemaPersistedState = { collections: [], fields: [], relations: [] };

afterEach(() => {
	vi.clearAllMocks();
});

describe('computeWholeRunInputs', () => {
	it('returns empty inputs and reads no folders for a configuration-only tree', async () => {
		const desired = configFixture({ manifest: { version: 3, resources: ['roles'] } });

		const result = await computeWholeRunInputs(desired, [], {} as Knex);

		expect(result).toEqual({ schemaFields: [], availableFolderKeys: new Map(), preparationFolderKeys: new Set() });
		expect(vi.mocked(readFolderKeys)).not.toHaveBeenCalled();
	});

	it('reconciles the captured interface so a referenced declared folder is prepared', async () => {
		vi.mocked(readFolderKeys).mockResolvedValue({
			folderIdByKey: new Map([['existing', 'id-1']]),
			folderKeyById: new Map([['id-1', 'existing']]),
		});

		const collection = (field: SnapshotField): ConfigSchemaCollection => ({
			collection: 'articles',
			meta: {} as Exclude<ConfigSchemaCollection['meta'], undefined>,
			schema: { name: 'articles' } as Exclude<ConfigSchemaCollection['schema'], undefined>,
			fields: [field],
			relations: [],
		});

		// The target's cover field is an upload interface; the desired tree omits the interface but moves the folder
		// reference to a newly declared folder, so only reconciliation against the captured schema reveals the reference.
		const currentSchema = [
			collection({
				collection: 'articles',
				field: 'cover',
				type: 'uuid',
				meta: { interface: 'file', options: { folder: 'existing' } },
				schema: { name: 'cover' },
			} as unknown as SnapshotField),
		];

		const desired = configFixture({
			manifest: { version: 3, resources: ['schema', 'folders'] },
			folders: [{ key: 'gallery', name: 'Gallery' }],
			schema: [
				collection({
					collection: 'articles',
					field: 'cover',
					type: 'uuid',
					meta: { options: { folder: 'gallery' } },
					schema: { name: 'cover' },
				} as unknown as SnapshotField),
			],
		});

		const result = await computeWholeRunInputs(desired, currentSchema, {} as Knex);

		const cover = result.schemaFields.find((field) => field.field === 'cover');
		expect((cover?.meta as { interface?: string } | null)?.interface).toBe('file');

		expect(result.availableFolderKeys).toEqual(
			new Map([
				['existing', 'id-1'],
				['gallery', 'gallery'],
			])
		);

		expect(result.preparationFolderKeys).toEqual(new Set(['gallery']));
	});
});

describe('applySchemaStep', () => {
	it('passes the schema inputs to the planner and feeds applyDiff the diff and captured hash', async () => {
		const currentSchema: ConfigSchemaCollection[] = [
			{
				collection: 'before',
				meta: {} as Exclude<ConfigSchemaCollection['meta'], undefined>,
				schema: { name: 'before' } as Exclude<ConfigSchemaCollection['schema'], undefined>,
				fields: [],
				relations: [],
			},
		];

		const desiredSchema: ConfigSchemaCollection[] = [
			{
				collection: 'after',
				meta: {} as Exclude<ConfigSchemaCollection['meta'], undefined>,
				schema: { name: 'after' } as Exclude<ConfigSchemaCollection['schema'], undefined>,
				fields: [],
				relations: [],
			},
		];

		const schemaStoredFields: SnapshotField[] = [
			{
				collection: 'before',
				field: 'id',
				type: 'integer',
				meta: {},
				schema: { name: 'id' },
			} as unknown as SnapshotField,
		];

		const diff = { collections: [], fields: [], relations: [] };
		vi.mocked(computeSchemaDiff).mockReturnValue({ diff } as never);
		const database = {} as Knex;

		await applySchemaStep({
			currentSchema,
			desiredSchema,
			schemaStoredFields,
			expectedHash: 'captured-hash',
			database,
		});

		expect(vi.mocked(computeSchemaDiff)).toHaveBeenCalledWith(currentSchema, desiredSchema, schemaStoredFields);
		expect(vi.mocked(applyDiff)).toHaveBeenCalledWith(diff, { database, expectedHash: 'captured-hash' });
	});
});

describe('applyConfigurationStep', () => {
	const editor = { key: 'editor', name: 'Editor', admin_access: false, app_access: true };

	const desired = configFixture({ manifest: { version: 3, resources: ['schema', 'roles'] }, roles: [editor] });
	const currentWithoutEditor = configFixture({ manifest: { version: 3, resources: ['roles'] } });
	const currentWithEditor = configFixture({ manifest: { version: 3, resources: ['roles'] }, roles: [editor] });

	function currentRead(config: CairnConfig, roleKeys: string[]): Awaited<ReturnType<typeof readCurrentConfig>> {
		return {
			config,
			currentRoleKeys: new Set(roleKeys),
			currentFolderKeys: new Set(),
			currentFolderParents: new Map(),
			stateToken: { resources: ['roles'], digest: 'digest' } satisfies ConfigStateToken,
		};
	}

	function emptyPlan(): ConfigPlan {
		return {
			managedResources: ['roles'],
			schema: { create: [], update: [], delete: [] },
			roles: { create: [], update: [], delete: [] },
			permissions: { create: [], update: [], delete: [] },
			folders: { create: [], update: [], delete: [] },
			settings: { create: [], update: [], delete: [] },
			'extension-settings': { create: [], update: [], delete: [] },
			translations: { create: [], update: [], delete: [] },
			protections: [],
		};
	}

	function plannedRoleChange(): ConfigPlan {
		return { ...emptyPlan(), roles: { create: [editor], update: [], delete: [] } };
	}

	function applyResult(): ApplyResult {
		return {
			schema: { created: 0, updated: 0, deleted: 0 },
			roles: { created: [], updated: [], deleted: [] },
			permissions: { created: 0, updated: 0, deleted: 0 },
			folders: { created: [], updated: [], deleted: [] },
			settings: { updated: [] },
			'extension-settings': { created: 0, updated: 0, deleted: 0 },
			translations: { created: 0, updated: 0, deleted: 0 },
		};
	}

	const context = { mode: 'request', accountability: { admin: true } } as unknown as ConfigApplySecurityContext;

	it('reads and plans over the non-schema kinds only and applies with the matching state token', async () => {
		const capture = currentRead(currentWithoutEditor, []);
		const plan = plannedRoleChange();
		const result: ApplyResult = { ...applyResult(), roles: { created: ['editor'], updated: [], deleted: [] } };

		vi.mocked(readCurrentConfig).mockResolvedValue(capture);
		vi.mocked(computeConfigPlan).mockReturnValue(plan);
		vi.mocked(applyConfigPlan).mockResolvedValue(result);

		const returned = await applyConfigurationStep(desired, ['roles'], {} as Knex, false, context);

		expect(vi.mocked(readCurrentConfig).mock.calls[0]![0]).toMatchObject({ resources: ['roles'] });

		const [planCurrent, configDesired] = vi.mocked(computeConfigPlan).mock.calls[0]!;
		expect(planCurrent).toBe(capture.config);
		expect(configDesired.manifest.resources).toEqual(['roles']);

		expect(vi.mocked(applyConfigPlan).mock.calls[0]![0]).toBe(plan);

		expect(vi.mocked(applyConfigPlan).mock.calls[0]![1]).toMatchObject({
			expectedStateToken: capture.stateToken,
			context,
		});

		expect(returned).toBe(result);
	});

	it('returns undefined without applying when the configuration plan is empty', async () => {
		vi.mocked(readCurrentConfig).mockResolvedValue(currentRead(currentWithEditor, ['editor']));
		vi.mocked(computeConfigPlan).mockReturnValue(emptyPlan());

		const returned = await applyConfigurationStep(desired, ['roles'], {} as Knex, false, context);

		expect(returned).toBeUndefined();
		expect(vi.mocked(applyConfigPlan)).not.toHaveBeenCalled();
	});
});

describe('failureStatus', () => {
	it('reports a post-commit maintenance failure on either engine as committed', () => {
		expect(failureStatus(new Coded('SCHEMA_POST_COMMIT_FAILED'))).toBe('committed');
		expect(failureStatus(new Coded('CONFIG_POST_COMMIT_FAILED'))).toBe('committed');
	});

	it('reports a schema apply failure by its persisted state', () => {
		expect(failureStatus(new Coded('SCHEMA_APPLY_FAILED', { persisted }))).toBe('failed');
		expect(failureStatus(new Coded('SCHEMA_APPLY_FAILED', { persisted: 'unknown' }))).toBe('unknown');
	});

	it('reports a rolled-back transaction as rolled_back on either engine', () => {
		expect(failureStatus(new Coded('CONFIG_APPLY_FAILED'))).toBe('rolled_back');
		expect(failureStatus(new Coded('SCHEMA_STATE_CHANGED'))).toBe('rolled_back');
		expect(failureStatus(new Coded('CONFIG_STATE_CHANGED'))).toBe('rolled_back');
	});

	it('reports an unrecognized or non-coded error as failed', () => {
		expect(failureStatus(new Coded('CONFIG_PROTECTED_RECORD'))).toBe('failed');
		expect(failureStatus(new Error('boom'))).toBe('failed');
	});

	it('reads the first error of a thrown array', () => {
		expect(failureStatus([new Coded('CONFIG_POST_COMMIT_FAILED')])).toBe('committed');
	});
});

describe('failureDetail', () => {
	it('keeps only the persisted state and foreign-key flag of a schema apply failure', () => {
		const detail = failureDetail(
			new Coded('SCHEMA_APPLY_FAILED', { persisted, foreignKeysRestored: false, cause: 'ignored', note: 'leak' })
		);

		expect(detail).toEqual({ persisted, foreignKeysRestored: false });
	});

	it('omits the foreign-key flag when enforcement was restored', () => {
		expect(failureDetail(new Coded('SCHEMA_APPLY_FAILED', { persisted: 'unknown' }))).toEqual({ persisted: 'unknown' });
	});

	it('projects the persisted state to its declared shape, dropping unknown keys and malformed entries', () => {
		const detail = failureDetail(
			new Coded('SCHEMA_APPLY_FAILED', {
				persisted: {
					collections: [
						{ collection: 'articles', operation: 'create', table: 'applied', metadata: 'applied', note: 'leak' },
						{ collection: 'bad', operation: 'wipe', table: 'applied', metadata: 'applied' },
					],
					fields: [
						{ collection: 'articles', field: 'title', operation: 'update', column: 'HACKED', metadata: 'applied' },
					],
					relations: 'not-an-array',
					note: 'leak',
				},
			})
		);

		expect(detail).toEqual({
			persisted: {
				collections: [{ collection: 'articles', operation: 'create', table: 'applied', metadata: 'applied' }],
				fields: [
					{ collection: 'articles', field: 'title', operation: 'update', column: 'unknown', metadata: 'applied' },
				],
				relations: [],
			},
		});
	});

	it('reports an unrecognized or non-object persisted value as unknown', () => {
		expect(failureDetail(new Coded('SCHEMA_APPLY_FAILED', { persisted: 42 }))).toEqual({ persisted: 'unknown' });
	});

	it('keeps only the maintenance phase of a post-commit failure on either engine', () => {
		expect(failureDetail(new Coded('SCHEMA_POST_COMMIT_FAILED', { committed: true, phase: 'cache' }))).toEqual({
			phase: 'cache',
		});

		expect(failureDetail(new Coded('CONFIG_POST_COMMIT_FAILED', { committed: true, phase: 'actions' }))).toEqual({
			phase: 'actions',
		});
	});

	it('drops a maintenance phase that is not a recognized value', () => {
		expect(failureDetail(new Coded('SCHEMA_POST_COMMIT_FAILED', { phase: { nested: 'leak' } }))).toBeUndefined();
		expect(failureDetail(new Coded('CONFIG_POST_COMMIT_FAILED', { phase: 'bogus' }))).toBeUndefined();
	});

	it('returns nothing for an error that carries no persisted or maintenance detail', () => {
		expect(failureDetail(new Coded('CONFIG_APPLY_FAILED', { note: 'leak' }))).toBeUndefined();
		expect(failureDetail(new Error('boom'))).toBeUndefined();
	});
});
