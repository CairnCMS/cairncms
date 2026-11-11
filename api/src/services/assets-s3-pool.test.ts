import { DriverS3 } from '@cairncms/storage-driver-s3';
import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buffer } from 'node:stream/consumers';
import type { MockedFunction } from 'vitest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AssetsService } from './assets.js';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const BODY = Buffer.alloc(1024 * 1024, 7);
const POOL_SIZE = 2;

const storage = vi.hoisted(() => ({ location: null as unknown }));

vi.mock('../storage/index.js', () => ({
	getStorage: vi.fn(async () => ({ location: () => storage.location })),
}));

vi.mock('./authorization.js', () => ({
	AuthorizationService: vi.fn().mockImplementation(function () {
		return { checkAccess: vi.fn() };
	}),
}));

vi.mock('../database/index.js', () => ({
	default: vi.fn(),
}));

const adminAccountability: Accountability = {
	user: 'admin-uuid',
	role: 'role-uuid',
	admin: true,
	app: true,
	ip: '127.0.0.1',
	permissions: [],
};

const schema = { collections: {}, relations: [] } as unknown as SchemaOverview;

let server: http.Server;
let driver: DriverS3;
let httpAgent: http.Agent;
let db: MockedFunction<Knex>;
let tracker: Tracker;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		req.resume();

		res.writeHead(200, {
			'Content-Type': 'image/jpeg',
			'Content-Length': String(BODY.length),
			'Last-Modified': new Date('2026-11-10T00:00:00.000Z').toUTCString(),
			ETag: '"pool"',
		});

		res.end(req.method === 'HEAD' ? undefined : BODY);
	});

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve());
	});

	const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	driver = new DriverS3({
		bucket: 'pool',
		key: 'pool',
		secret: 'pool',
		region: 'us-east-1',
		endpoint,
		forcePathStyle: true,
	});

	const S3Client = driver['client'].constructor;
	httpAgent = new http.Agent({ maxSockets: POOL_SIZE, keepAlive: true });

	driver['client'] = new S3Client({
		region: 'us-east-1',
		endpoint,
		forcePathStyle: true,
		credentials: { accessKeyId: 'pool', secretAccessKey: 'pool' },
		maxAttempts: 1,
		requestHandler: { connectionTimeout: 1000, httpAgent },
	});

	storage.location = driver;
	db = vi.mocked(knex.default({ client: MockClient }));
	tracker = createTracker(db);
});

afterEach(() => {
	tracker.reset();
});

afterAll(async () => {
	driver['client'].destroy();
	httpAgent.destroy();
	server.closeAllConnections();

	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
});

function primeKnex() {
	tracker.on.select('directus_settings').response({});

	tracker.on.select('directus_files').response([
		{
			id: VALID_UUID,
			filename_disk: `${VALID_UUID}.jpg`,
			filename_download: 'photo.jpg',
			type: 'image/jpeg',
			filesize: BODY.length,
			width: 800,
			height: 600,
			modified_on: '2026-11-10T00:00:00.000Z',
			storage: 's3',
		},
	]);
}

async function serveConcurrently(transformationParams: Record<string, unknown>) {
	primeKnex();
	const service = new AssetsService({ knex: db, accountability: adminAccountability, schema });

	return Promise.all(
		Array.from({ length: POOL_SIZE }, async () => {
			const { stream } = await service.getAsset(VALID_UUID, { transformationParams });
			return (await buffer(stream)).length;
		})
	);
}

describe('AssetsService.getAsset with a shared S3 connection pool', () => {
	it('completes concurrent requests for the source file at pool capacity', async () => {
		expect(await serveConcurrently({})).toEqual([BODY.length, BODY.length]);
	});

	it('completes concurrent requests for a cached variant at pool capacity', async () => {
		expect(await serveConcurrently({ width: 100 })).toEqual([BODY.length, BODY.length]);
	});
});
