import type { Accountability } from '@cairncms/types';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyResult, CairnConfig, ConfigKind } from '../types/config.js';
import type { SnapshotField } from '../types/index.js';

vi.mock('../env.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../env.js')>();
	return { ...actual, default: actual.default, getEnv: () => actual.default };
});

vi.mock('../logger.js', () => {
	const sink: Record<string, unknown> = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};

	sink['child'] = () => sink;

	return { default: sink };
});

vi.mock('../database/index.js', () => ({ default: vi.fn(() => ({})), getDatabaseClient: vi.fn(() => 'postgres') }));

vi.mock('../utils/folder-references.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../utils/folder-references.js')>();

	return {
		...actual,
		readFolderKeys: vi.fn(async () => ({
			folderIdByKey: new Map<string, string>(),
			folderKeyById: new Map<string, string>(),
		})),
	};
});

vi.mock('../extensions.js', () => ({
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

vi.mock('../utils/get-schema.js', () => ({ getSchema: vi.fn(async () => ({ collections: {} })) }));

vi.mock('../utils/get-config-snapshot.js', () => ({ readCurrentConfig: vi.fn() }));

vi.mock('../utils/apply-config-plan.js', () => ({ applyConfigPlan: vi.fn() }));

vi.mock('../utils/apply-folder-preparation.js', () => ({ applyFolderPreparation: vi.fn() }));

vi.mock('../utils/config/apply-steps.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../utils/config/apply-steps.js')>();
	return { ...actual, applySchemaStep: vi.fn() };
});

vi.mock('../middleware/respond.js', () => ({
	respond: (_req: unknown, res: { json: (body: unknown) => void; locals: Record<string, unknown> }) =>
		res.json(res.locals['payload']),
}));

import { InvalidPayloadException } from '../exceptions/index.js';
import { SchemaApplyFailedException } from '../exceptions/schema-apply-failed.js';
import { SchemaPostCommitFailedException } from '../exceptions/schema-post-commit-failed.js';
import { SchemaStateChangedException } from '../exceptions/schema-state-changed.js';
import logger from '../logger.js';
import errorHandler from '../middleware/error-handler.js';
import { applyConfigPlan } from '../utils/apply-config-plan.js';
import { applyFolderPreparation } from '../utils/apply-folder-preparation.js';
import { applySchemaStep } from '../utils/config/apply-steps.js';
import { getDescriptor, listConfigKinds } from '../utils/config/registry.js';
import { readCurrentConfig } from '../utils/get-config-snapshot.js';
import { version } from '../utils/package.js';
import configController from './config.js';

const STORED_MARKER = 'PRIVATE_STORED_MARKER';
const ADMIN: Accountability = { admin: true, app: true, user: null, role: null, ip: null } as never;

const EMPTY_CURRENT: CairnConfig = {
	manifest: { version: 3, resources: ['schema'] },
	roles: [],
	permissions: [],
	folders: [],
	settings: [],
	'extension-settings': [],
	translations: [],
	schema: [],
};

function storedFields(): SnapshotField[] {
	return [
		{ collection: STORED_MARKER, field: 'secret', type: 'string', meta: {}, schema: { name: 'secret' } } as never,
	];
}

function articlesBody(...fields: Record<string, unknown>[]) {
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
				meta: {},
				schema: { name: 'articles' },
				fields: fields.map((field) => ({ collection: 'articles', ...field })),
				relations: [],
			},
		],
	};
}

const EDITOR_ROLE = { key: 'editor', name: 'Editor', admin_access: false, app_access: true };
const COVERS_FOLDER = { key: 'covers', name: 'covers', parent: null };

let preparedFolderKeys: string[] = [];

function prepareFolders(keys: string[]) {
	vi.mocked(applyFolderPreparation).mockImplementation(async () => {
		preparedFolderKeys = keys;
		return keys;
	});
}

function engineResult(slices: Partial<ApplyResult> = {}): ApplyResult {
	const empty = Object.fromEntries(
		listConfigKinds().map((kind) => [kind, getDescriptor(kind).handler.emptyResult()])
	) as unknown as ApplyResult;

	return { ...empty, ...slices };
}

const ROLE_CREATED = engineResult({ roles: { created: [EDITOR_ROLE.key], updated: [], deleted: [] } });
const NOTHING_APPLIED = engineResult();

function combinedBody() {
	const body = articlesBody(
		{ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } },
		{
			field: 'cover',
			type: 'uuid',
			meta: { interface: 'file', options: { folder: COVERS_FOLDER.key } },
			schema: { name: 'cover' },
		}
	);

	return {
		...body,
		manifest: {
			version: 3,
			resources: ['folders', 'roles', 'schema'],
			schema: { release: version, vendor: 'postgres' },
		},
		folders: [COVERS_FOLDER],
		roles: [EDITOR_ROLE],
	};
}

function rolesOnlyBody() {
	return {
		...articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }),
		manifest: { version: 3, resources: ['roles'] },
		roles: [],
		schema: [],
	};
}

function makeApp() {
	const app = express();
	app.use(express.json());

	app.use((req, _res, next) => {
		req.accountability = ADMIN;
		next();
	});

	app.use('/config', configController);
	app.use(errorHandler);
	return app;
}

function readResult(resources: readonly ConfigKind[], withStoredFields = true) {
	const schemaCapture = resources.includes('schema') && withStoredFields;

	const folders = preparedFolderKeys.map((key) => ({ key, name: key, parent: null }));

	return {
		config: { ...EMPTY_CURRENT, manifest: { version: 3 as const, resources: [...resources] }, folders },
		currentRoleKeys: new Set<string>(),
		currentFolderKeys: new Set(preparedFolderKeys),
		currentFolderParents: new Map<string, string | null>(preparedFolderKeys.map((key) => [key, null])),
		stateToken: { resources: [...resources], digest: 'digest' },
		...(schemaCapture && { schemaStoredFields: storedFields(), schemaKeyFormHash: 'key-form-hash' }),
	};
}

function stubRead(withStoredFields = true) {
	vi.mocked(readCurrentConfig).mockImplementation(
		async (options) => readResult(options.resources ?? [], withStoredFields) as never
	);
}

function runRecordsFor(runId: string): Array<Record<string, unknown>> {
	return vi
		.mocked(logger.info)
		.mock.calls.map((call): unknown => call[0])
		.filter(
			(record): record is Record<string, unknown> =>
				typeof record === 'object' &&
				record !== null &&
				(record as Record<string, unknown>)['event'] === 'config.run.finished' &&
				(record as Record<string, unknown>)['runId'] === runId
		);
}

beforeEach(() => {
	preparedFolderKeys = [];
	stubRead();
	vi.mocked(applyFolderPreparation).mockResolvedValue([]);
	vi.mocked(applySchemaStep).mockResolvedValue(undefined);
	vi.mocked(applyConfigPlan).mockResolvedValue(NOTHING_APPLIED);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('POST /config/apply schema wiring', () => {
	it('serializes a version 3 schema dry run through the real pipeline and excludes the private capture', async () => {
		const response = await request(makeApp())
			.post('/config/apply?dry_run=true')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(200);
		expect(response.body.data.planVersion).toBe(3);

		const kinds = response.body.data.changes.map((change: { kind: string }) => change.kind);
		expect(kinds).toContain('collections');
		expect(kinds).toContain('fields');

		expect(JSON.stringify(response.body)).not.toContain(STORED_MARKER);
	});

	it('refuses a malformed version 3 schema body at the HTTP boundary', async () => {
		const response = await request(makeApp())
			.post('/config/apply?dry_run=true')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'not-a-type', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
		expect(response.body.errors[0].message).toContain('type');
	});

	it('admits a collection-scoped extension setting for a collection the schema plan creates', async () => {
		const body = {
			...articlesBody({ field: 'id', type: 'integer', meta: {}, schema: { name: 'id', is_primary_key: true } }),
			manifest: {
				version: 3,
				resources: ['extension-settings', 'schema'],
				schema: { release: version, vendor: 'postgres' },
			},
			'extension-settings': [
				{ subject: '@cairncms/extension-widget', global: {}, collections: { articles: { label: 'x' } } },
			],
		};

		const response = await request(makeApp())
			.post('/config/apply?dry_run=true')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(body);

		expect(response.status).toBe(200);

		const kinds = response.body.data.changes.map((change: { kind: string }) => change.kind);
		expect(kinds).toContain('extension-settings');
	});

	it('fails a version 3 dry run when the private capture was not forwarded', async () => {
		stubRead(false);

		const response = await request(makeApp())
			.post('/config/apply?dry_run=true')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(500);
		expect(response.body.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
	});

	it('applies folders, schema, and configuration in order in one request and reports every step', async () => {
		prepareFolders([COVERS_FOLDER.key]);
		vi.mocked(applyConfigPlan).mockResolvedValue(ROLE_CREATED);

		const response = await request(makeApp())
			.post('/config/apply')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(combinedBody());

		expect(response.status).toBe(200);
		expect(response.body.data).toEqual(ROLE_CREATED);
		expect(response.body.meta.result).toBe('applied');
		expect(response.body.meta.steps).toEqual({ folders: 'committed', schema: 'committed', configuration: 'committed' });

		const foldersOrder = vi.mocked(applyFolderPreparation).mock.invocationCallOrder[0]!;
		const schemaOrder = vi.mocked(applySchemaStep).mock.invocationCallOrder[0]!;
		const configurationOrder = vi.mocked(applyConfigPlan).mock.invocationCallOrder[0]!;
		expect(foldersOrder).toBeLessThan(schemaOrder);
		expect(schemaOrder).toBeLessThan(configurationOrder);

		const [configurationPlan] = vi.mocked(applyConfigPlan).mock.calls[0]!;
		expect(configurationPlan.folders.create).toEqual([]);
		expect(configurationPlan.roles.create.map((role) => role.key)).toEqual([EDITOR_ROLE.key]);

		const records = runRecordsFor(response.headers['x-config-run-id']!);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ result: 'applied', steps: response.body.meta.steps });
	});

	it('applies the schema step without handing the caller identity to the schema engine', async () => {
		vi.mocked(applyFolderPreparation).mockResolvedValue([]);

		const response = await request(makeApp())
			.post('/config/apply')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(200);
		expect(response.body.data).toBeNull();
		expect(response.body.meta.result).toBe('applied');
		expect(response.body.meta.steps).toEqual({ folders: 'skipped', schema: 'committed', configuration: 'skipped' });

		expect(applySchemaStep).toHaveBeenCalledTimes(1);

		const handoff = vi.mocked(applySchemaStep).mock.calls[0]![0];
		expect(handoff.expectedHash).toBe('key-form-hash');
		expect(handoff).not.toHaveProperty('accountability');
		expect(handoff).not.toHaveProperty('context');
	});

	it('returns the engine result unchanged for a configuration-only no-op', async () => {
		const response = await request(makeApp())
			.post('/config/apply')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(rolesOnlyBody());

		expect(response.status).toBe(200);
		expect(response.body.data).toEqual(NOTHING_APPLIED);
		expect(response.body.meta.result).toBe('no_changes');
		expect(response.body.meta.steps).toEqual({ folders: 'not_run', schema: 'not_run', configuration: 'skipped' });
		expect(applyFolderPreparation).not.toHaveBeenCalled();
		expect(applySchemaStep).not.toHaveBeenCalled();
	});

	it('refuses an extension setting whose collection is neither current nor planned, before any write', async () => {
		const body = {
			...articlesBody({ field: 'id', type: 'integer', meta: {}, schema: { name: 'id', is_primary_key: true } }),
			manifest: {
				version: 3,
				resources: ['extension-settings', 'schema'],
				schema: { release: version, vendor: 'postgres' },
			},
			'extension-settings': [
				{ subject: '@cairncms/extension-widget', global: {}, collections: { ghost_collection: { label: 'x' } } },
			],
		};

		const response = await request(makeApp()).post('/config/apply').set('User-Agent', 'cairncms-cli/1.6.0').send(body);

		expect(response.status).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
		expect(response.body.errors[0].message).toContain('ghost_collection');
		expect(applyFolderPreparation).not.toHaveBeenCalled();
		expect(applySchemaStep).not.toHaveBeenCalled();
		expect(applyConfigPlan).not.toHaveBeenCalled();
	});

	it('names the folders step and runs nothing after it when folder preparation fails', async () => {
		vi.mocked(applyFolderPreparation).mockRejectedValue(new Error('folder preparation failed'));

		const response = await request(makeApp())
			.post('/config/apply')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(combinedBody());

		expect(response.status).toBe(500);

		const extensions = response.body.errors[0].extensions;
		expect(extensions.steps).toEqual({ folders: 'failed', schema: 'not_run', configuration: 'not_run' });
		expect(extensions.failure).toEqual({ step: 'folders' });
		expect(applySchemaStep).not.toHaveBeenCalled();
		expect(applyConfigPlan).not.toHaveBeenCalled();

		const records = runRecordsFor(response.headers['x-config-run-id']!);
		expect(records).toHaveLength(1);

		expect(records[0]).toMatchObject({
			result: 'failed',
			errorCode: 'UNEXPECTED',
			steps: extensions.steps,
			failure: extensions.failure,
		});
	});

	it.each([
		{
			name: 'rolled back on a concurrent change',
			thrown: () => new SchemaStateChangedException(),
			status: 409,
			code: 'SCHEMA_STATE_CHANGED',
			recordCode: 'SCHEMA_STATE_CHANGED',
			step: 'rolled_back',
			failure: { step: 'schema' },
			result: 'state_changed',
		},
		{
			name: 'unknown when the persisted state cannot be read',
			thrown: () => new SchemaApplyFailedException('unknown'),
			status: 500,
			code: 'SCHEMA_APPLY_FAILED',
			recordCode: 'SCHEMA_APPLY_FAILED',
			step: 'unknown',
			failure: { step: 'schema', detail: { persisted: 'unknown' } },
			result: 'failed',
		},
		{
			name: 'committed when a post-commit maintenance phase fails',
			thrown: () => new SchemaPostCommitFailedException('cache'),
			status: 500,
			code: 'SCHEMA_POST_COMMIT_FAILED',
			recordCode: 'SCHEMA_POST_COMMIT_FAILED',
			step: 'committed',
			failure: { step: 'schema', detail: { phase: 'cache' } },
			result: 'post_apply_failed',
		},
		{
			name: 'failed on a schema refusal',
			thrown: () =>
				new InvalidPayloadException('Field "articles.title" can\'t remove its column and remain as a field.'),
			status: 400,
			code: 'INVALID_PAYLOAD',
			recordCode: 'UNEXPECTED',
			step: 'failed',
			failure: { step: 'schema' },
			result: 'failed',
		},
	])('names the schema step $name after folder preparation committed, and runs no configuration', async (c) => {
		prepareFolders([COVERS_FOLDER.key]);
		vi.mocked(applySchemaStep).mockRejectedValue(c.thrown());

		const response = await request(makeApp())
			.post('/config/apply')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(combinedBody());

		expect(response.status).toBe(c.status);

		const extensions = response.body.errors[0].extensions;
		expect(extensions.code).toBe(c.code);
		expect(extensions.steps).toEqual({ folders: 'committed', schema: c.step, configuration: 'not_run' });
		expect(extensions.failure).toEqual(c.failure);
		expect(applyConfigPlan).not.toHaveBeenCalled();

		const records = runRecordsFor(response.headers['x-config-run-id']!);
		expect(records).toHaveLength(1);

		expect(records[0]).toMatchObject({
			result: c.result,
			errorCode: c.recordCode,
			steps: extensions.steps,
			failure: extensions.failure,
		});
	});

	it('names the configuration step when it fails after the schema step committed', async () => {
		prepareFolders([COVERS_FOLDER.key]);
		vi.mocked(applyConfigPlan).mockRejectedValue(new InvalidPayloadException('configuration failed'));

		const response = await request(makeApp())
			.post('/config/apply')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(combinedBody());

		expect(response.status).toBe(400);

		const extensions = response.body.errors[0].extensions;
		expect(extensions.steps).toEqual({ folders: 'committed', schema: 'committed', configuration: 'failed' });
		expect(extensions.failure).toEqual({ step: 'configuration' });

		const records = runRecordsFor(response.headers['x-config-run-id']!);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ result: 'failed', steps: extensions.steps, failure: extensions.failure });
	});
});
