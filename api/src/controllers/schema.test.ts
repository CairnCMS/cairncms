import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../types/index.js';

const IMAGES_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DANGLING_ID = 'cccccccc-3333-4333-8333-cccccccccccc';

const state = vi.hoisted(() => ({
	defaultVersion: 1 as 1 | 2,
	current: undefined as unknown,
	folderSource: undefined as unknown as () => { id: string; key: string }[],
}));

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

vi.mock('../utils/schema-contract.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../utils/schema-contract.js')>();

	return {
		...actual,
		get DEFAULT_SNAPSHOT_VERSION() {
			return state.defaultVersion;
		},
	};
});

vi.mock('../database/index.js', () => ({
	default: vi.fn(() => ({
		select: () => ({
			from: () => {
				const rows = state.folderSource();

				return Object.assign(Promise.resolve(rows), {
					where: (_column: string, id: string) => ({ first: async () => rows.find((row) => row.id === id) }),
				});
			},
		}),
	})),
	getDatabaseClient: vi.fn(() => 'sqlite'),
}));

vi.mock('../utils/package.js', () => ({ version: '1.0.0' }));
vi.mock('../utils/get-snapshot.js', () => ({ getSnapshot: vi.fn(async () => structuredClone(state.current)) }));
vi.mock('../utils/apply-diff.js', () => ({ applyDiff: vi.fn(async () => undefined) }));

import errorHandler from '../middleware/error-handler.js';
import { applyDiff } from '../utils/apply-diff.js';
import { getVersionedHash } from '../utils/get-versioned-hash.js';
import schemaController from './schema.js';

const admin = { user: 'admin-id', role: 'admin-role-id', admin: true, app: true, ip: '127.0.0.1' };

function makeApp() {
	const app = express();

	app.use(express.json());

	app.use((req: Record<string, unknown>, _res: unknown, next: () => void) => {
		req['accountability'] = admin;
		req['sanitizedQuery'] = {};
		next();
	});

	app.use('/schema', schemaController);
	app.use(errorHandler);

	return app;
}

function snapshot(folder: string, note: string | null = null, version: 1 | 2 = 1): Snapshot {
	return {
		version,
		...(version === 2 ? { release: '1.0.0' } : { directus: '1.0.0' }),
		vendor: 'sqlite',
		collections: [{ collection: 'articles', meta: { collection: 'articles' }, schema: { name: 'articles' } }],
		fields: [
			{
				collection: 'articles',
				field: 'image',
				type: 'uuid',
				schema: null,
				meta: { collection: 'articles', field: 'image', interface: 'file', note, options: { folder } },
			},
		],
		relations: [],
	} as unknown as Snapshot;
}

const folders = [{ id: IMAGES_ID, key: 'images' }];

beforeEach(() => {
	state.defaultVersion = 1;
	state.current = snapshot(IMAGES_ID);
	state.folderSource = vi.fn(() => folders);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('GET /schema/snapshot', () => {
	it('returns version 1 with stored folder IDs by default', async () => {
		const res = await request(makeApp()).get('/schema/snapshot');

		expect(res.status).toBe(200);
		expect(res.body.data.version).toBe(1);
		expect(res.body.data.fields[0].meta.options.folder).toBe(IMAGES_ID);
	});

	it('returns version 2 with folder keys on request', async () => {
		const res = await request(makeApp()).get('/schema/snapshot?version=2');

		expect(res.status).toBe(200);
		expect(res.body.data.version).toBe(2);
		expect(res.body.data.fields[0].meta.options.folder).toBe('images');
	});

	it('refuses an unsupported version', async () => {
		const res = await request(makeApp()).get('/schema/snapshot?version=3');

		expect(res.status).toBe(400);
		expect(res.body.errors[0].extensions.code).toBe('INVALID_QUERY');
	});

	it('refuses a version 2 export of a field whose folder does not exist', async () => {
		state.current = snapshot(DANGLING_ID);

		const res = await request(makeApp()).get('/schema/snapshot?version=2');

		expect(res.status).toBe(422);
		expect(res.body.errors[0].message).toContain('Field "articles.image" references folder');
		expect(res.body.errors[0].message).toContain(DANGLING_ID);
	});
});

describe('POST /schema/diff and /schema/apply', () => {
	it('hashes the same key form the diff was computed from, and apply checks its own fresh read', async () => {
		vi.mocked(state.folderSource).mockReturnValueOnce(folders).mockReturnValue([]);

		const diffRes = await request(makeApp()).post('/schema/diff').send(snapshot('images', 'Hero image', 2));

		expect(diffRes.status).toBe(200);
		expect(state.folderSource).toHaveBeenCalledOnce();
		expect(diffRes.body.data.hash).toBe(getVersionedHash(snapshot('images')));

		const refused = await request(makeApp()).post('/schema/apply').send(diffRes.body.data);

		expect(refused.status).toBe(400);
		expect(refused.body.errors[0].message).toContain('Provided hash does not match');
		expect(applyDiff).not.toHaveBeenCalled();

		state.folderSource = vi.fn(() => folders);

		const applied = await request(makeApp()).post('/schema/apply').send(diffRes.body.data);

		expect(applied.status).toBe(204);
		expect(applyDiff).toHaveBeenCalledOnce();
	});

	it('keeps internal reads in stored-ID form when the export default is version 2', async () => {
		state.defaultVersion = 2;
		state.current = snapshot(DANGLING_ID);

		const exported = await request(makeApp()).get('/schema/snapshot');
		expect(exported.status).toBe(422);

		const diffRes = await request(makeApp()).post('/schema/diff').send(snapshot('images', null, 2));

		expect(diffRes.status).toBe(200);
		expect(diffRes.body.data.diff.fields[0].diff[0].rhs).toBe('images');

		const applied = await request(makeApp()).post('/schema/apply').send(diffRes.body.data);

		expect(applied.status).toBe(204);

		const [current] = vi.mocked(applyDiff).mock.calls[0]!;
		expect(current.fields[0]!.meta.options).toEqual({ folder: DANGLING_ID });
	});
});
