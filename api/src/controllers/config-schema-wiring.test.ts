import type { Accountability } from '@cairncms/types';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CairnConfig } from '../types/config.js';
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

import { SchemaApplyFailedException } from '../exceptions/schema-apply-failed.js';
import { SchemaPostCommitFailedException } from '../exceptions/schema-post-commit-failed.js';
import { SchemaStateChangedException } from '../exceptions/schema-state-changed.js';
import logger from '../logger.js';
import errorHandler from '../middleware/error-handler.js';
import { applyFolderPreparation } from '../utils/apply-folder-preparation.js';
import { applySchemaStep } from '../utils/config/apply-steps.js';
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

function articlesBody(field: Record<string, unknown>) {
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
				fields: [{ collection: 'articles', ...field }],
				relations: [],
			},
		],
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

function readResult(withStoredFields: boolean) {
	return {
		config: EMPTY_CURRENT,
		currentRoleKeys: new Set<string>(),
		currentFolderKeys: new Set<string>(),
		currentFolderParents: new Map<string, string | null>(),
		stateToken: { resources: ['schema'], digest: 'digest' },
		...(withStoredFields && { schemaStoredFields: storedFields(), schemaKeyFormHash: 'key-form-hash' }),
	};
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
	vi.mocked(readCurrentConfig).mockResolvedValue(readResult(true) as never);
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
		vi.mocked(readCurrentConfig).mockResolvedValue(readResult(false) as never);

		const response = await request(makeApp())
			.post('/config/apply?dry_run=true')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(500);
		expect(response.body.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
	});

	it('names the folders step in the run outcome when folder preparation fails', async () => {
		vi.mocked(applyFolderPreparation).mockRejectedValue(new Error('folder preparation failed'));

		const response = await request(makeApp())
			.post('/config/apply?step=folders')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(500);

		const extensions = response.body.errors[0].extensions;
		expect(extensions.steps).toEqual({ folders: 'failed', schema: 'not_run', configuration: 'not_run' });
		expect(extensions.failure).toEqual({ step: 'folders' });
	});

	it('applies the schema step over HTTP without handing the caller identity to the schema engine', async () => {
		const response = await request(makeApp())
			.post('/config/apply?step=schema')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(200);
		expect(response.body.data).toBeNull();
		expect(response.body.meta.result).toBe('applied');
		expect(response.body.meta.steps).toEqual({ folders: 'not_run', schema: 'committed', configuration: 'not_run' });

		expect(applySchemaStep).toHaveBeenCalledTimes(1);

		const handoff = vi.mocked(applySchemaStep).mock.calls[0]![0];
		expect(handoff.expectedHash).toBe('key-form-hash');
		expect(handoff).not.toHaveProperty('accountability');
		expect(handoff).not.toHaveProperty('context');
	});

	it('names the schema step rolled back when a concurrent change conflicts with the apply', async () => {
		vi.mocked(applySchemaStep).mockRejectedValue(new SchemaStateChangedException());

		const response = await request(makeApp())
			.post('/config/apply?step=schema')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(409);

		const extensions = response.body.errors[0].extensions;
		expect(extensions.code).toBe('SCHEMA_STATE_CHANGED');
		expect(extensions.steps).toEqual({ folders: 'not_run', schema: 'rolled_back', configuration: 'not_run' });
		expect(extensions.failure).toEqual({ step: 'schema' });

		const records = runRecordsFor(response.headers['x-config-run-id']!);
		expect(records).toHaveLength(1);

		expect(records[0]).toMatchObject({
			result: 'state_changed',
			errorCode: 'SCHEMA_STATE_CHANGED',
			steps: extensions.steps,
			failure: extensions.failure,
		});
	});

	it('names the schema step unknown when the apply failure cannot read the persisted state', async () => {
		vi.mocked(applySchemaStep).mockRejectedValue(new SchemaApplyFailedException('unknown'));

		const response = await request(makeApp())
			.post('/config/apply?step=schema')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(500);

		const extensions = response.body.errors[0].extensions;
		expect(extensions.code).toBe('SCHEMA_APPLY_FAILED');
		expect(extensions.steps).toEqual({ folders: 'not_run', schema: 'unknown', configuration: 'not_run' });
		expect(extensions.failure).toEqual({ step: 'schema', detail: { persisted: 'unknown' } });

		const records = runRecordsFor(response.headers['x-config-run-id']!);
		expect(records).toHaveLength(1);

		expect(records[0]).toMatchObject({
			result: 'failed',
			errorCode: 'SCHEMA_APPLY_FAILED',
			steps: extensions.steps,
			failure: extensions.failure,
		});
	});

	it('names the schema step committed when a post-commit maintenance phase fails', async () => {
		vi.mocked(applySchemaStep).mockRejectedValue(new SchemaPostCommitFailedException('cache'));

		const response = await request(makeApp())
			.post('/config/apply?step=schema')
			.set('User-Agent', 'cairncms-cli/1.6.0')
			.send(articlesBody({ field: 'title', type: 'string', meta: {}, schema: { name: 'title' } }));

		expect(response.status).toBe(500);

		const extensions = response.body.errors[0].extensions;
		expect(extensions.code).toBe('SCHEMA_POST_COMMIT_FAILED');
		expect(extensions.steps).toEqual({ folders: 'not_run', schema: 'committed', configuration: 'not_run' });
		expect(extensions.failure).toEqual({ step: 'schema', detail: { phase: 'cache' } });

		const records = runRecordsFor(response.headers['x-config-run-id']!);
		expect(records).toHaveLength(1);

		expect(records[0]).toMatchObject({
			result: 'post_apply_failed',
			errorCode: 'SCHEMA_POST_COMMIT_FAILED',
			steps: extensions.steps,
			failure: extensions.failure,
		});
	});
});
