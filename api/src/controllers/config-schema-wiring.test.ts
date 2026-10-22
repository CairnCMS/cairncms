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

vi.mock('../middleware/respond.js', () => ({
	respond: (_req: unknown, res: { json: (body: unknown) => void; locals: Record<string, unknown> }) =>
		res.json(res.locals['payload']),
}));

import errorHandler from '../middleware/error-handler.js';
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
		...(withStoredFields && { schemaStoredFields: storedFields() }),
	};
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
});
