import { BaseException } from '@cairncms/exceptions';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CairnConfig, ConfigPlan, SerializedConfigPlan } from '../types/config.js';

const { envOverrides } = vi.hoisted(() => ({ envOverrides: { LOG_STYLE: 'pretty' } as Record<string, unknown> }));

vi.mock('../env.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../env.js')>();

	const proxy = new Proxy(actual.default, {
		get(target, prop) {
			return prop in envOverrides ? envOverrides[prop as string] : Reflect.get(target, prop);
		},
	});

	return { ...actual, default: proxy, getEnv: () => proxy };
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

vi.mock('../database/index.js', () => ({ default: vi.fn(() => ({})) }));

vi.mock('../utils/get-schema.js', () => ({ getSchema: vi.fn(async () => ({})) }));

vi.mock('../utils/get-config-snapshot.js', () => ({ readCurrentConfig: vi.fn() }));

vi.mock('../utils/validate-desired-config.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../utils/validate-desired-config.js')>()),
	validateDesiredConfig: vi.fn(() => []),
}));

vi.mock('../utils/compute-config-plan.js', () => ({ computeConfigPlan: vi.fn() }));

vi.mock('../utils/enrich-config-plan.js', () => ({ enrichConfigPlan: vi.fn(async () => ({ warnings: [] })) }));

vi.mock('../utils/serialize-config-plan.js', () => ({ serializeConfigPlan: vi.fn() }));

vi.mock('../utils/apply-config-plan.js', () => ({ applyConfigPlan: vi.fn() }));

vi.mock('../middleware/respond.js', () => ({
	respond: (_req: unknown, res: { json: (body: unknown) => void; locals: Record<string, unknown> }) =>
		res.json(res.locals['payload']),
}));

import {
	ConfigPostCommitFailedException,
	ConfigProtectedRecordException,
	ConfigReadFailedException,
	ConfigStateChangedException,
	DestructiveChangesRequiredException,
} from '../exceptions/index.js';
import logger from '../logger.js';
import errorHandler from '../middleware/error-handler.js';
import { applyConfigPlan } from '../utils/apply-config-plan.js';
import { computeConfigPlan } from '../utils/compute-config-plan.js';
import { CONFIG_RUN_EVENT, CONFIG_RUN_ID_HEADER, type ConfigRunRecord } from '../utils/config/run-record.js';
import { readCurrentConfig } from '../utils/get-config-snapshot.js';
import { serializeConfigPlan } from '../utils/serialize-config-plan.js';
import { validateDesiredConfig } from '../utils/validate-desired-config.js';
import configController from './config.js';

const USER = '0f0a3b1c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const ROLE = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADER = CONFIG_RUN_ID_HEADER.toLowerCase();
const MARKER = 'HOSTILE_MARKER_7f3a';
const BEL = String.fromCharCode(7);

const BODY: CairnConfig = { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [] };

const ADMIN = { admin: true, app: true, user: USER, role: ROLE, ip: '10.0.0.1' };

const EMPTY_PLAN: ConfigPlan = {
	managedResources: ['roles'],
	roles: { create: [], update: [], delete: [] },
	permissions: { create: [], update: [], delete: [] },
	protections: [],
};

const CREATE_PLAN: ConfigPlan = {
	managedResources: ['roles'],
	roles: {
		create: [
			{
				key: 'editor',
				name: 'Editor',
				admin_access: false,
				app_access: true,
				icon: null,
				enforce_tfa: false,
				description: null,
				ip_access: null,
			},
		],
		update: [],
		delete: [],
	},
	permissions: { create: [], update: [], delete: [] },
	protections: [],
};

const SERIALIZED: SerializedConfigPlan = {
	planVersion: 2,
	manifestVersion: 1,
	changes: [],
	summary: { create: 1, update: 0, delete: 0 },
	warnings: [],
	protections: [],
};

const APPLY_RESULT = {
	roles: { created: ['editor'], updated: [], deleted: [] },
	permissions: { created: 0, updated: 0, deleted: 0 },
};

function makeApp(accountability: Record<string, unknown> | null) {
	const app = express();

	app.use(express.json());

	app.use((req: Record<string, unknown>, _res: unknown, next: () => void) => {
		req['accountability'] = accountability;
		next();
	});

	app.use('/config', configController);
	app.use(errorHandler);

	return app;
}

function apply(
	options: {
		dryRun?: boolean;
		destructive?: boolean;
		userAgent?: string;
		accountability?: Record<string, unknown> | null;
	} = {}
) {
	const query = new URLSearchParams();
	if (options.dryRun) query.set('dry_run', 'true');
	if (options.destructive) query.set('destructive', 'true');
	const suffix = query.size > 0 ? `?${query.toString()}` : '';

	return request(makeApp(options.accountability === undefined ? ADMIN : options.accountability))
		.post(`/config/apply${suffix}`)
		.set('User-Agent', options.userAgent ?? 'cairncms-cli/1.6.0')
		.send(BODY);
}

function records(): ConfigRunRecord[] {
	return vi
		.mocked(logger.info)
		.mock.calls.filter((call) => (call[0] as ConfigRunRecord | undefined)?.event === CONFIG_RUN_EVENT)
		.map((call) => call[0] as ConfigRunRecord);
}

function expectOneRecord(expected: Record<string, unknown>): ConfigRunRecord {
	const emitted = records();

	expect(emitted).toHaveLength(1);

	expect(emitted[0]).toMatchObject({
		event: CONFIG_RUN_EVENT,
		source: 'http',
		manifestVersion: 1,
		managedKinds: ['roles'],
		...expected,
	});

	expect(emitted[0]!.runId).toMatch(UUID);

	return emitted[0]!;
}

beforeEach(() => {
	envOverrides['LOG_STYLE'] = 'pretty';

	vi.mocked(logger.info).mockImplementation(() => undefined);
	vi.mocked(validateDesiredConfig).mockReturnValue([]);

	vi.mocked(readCurrentConfig).mockResolvedValue({
		config: BODY,
		currentRoleKeys: new Set<string>(),
		stateToken: { resources: ['roles'], digest: 'digest' },
	});

	vi.mocked(computeConfigPlan).mockReturnValue(CREATE_PLAN);
	vi.mocked(serializeConfigPlan).mockReturnValue(SERIALIZED);
	vi.mocked(applyConfigPlan).mockResolvedValue(APPLY_RESULT as never);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('POST /config/apply run record', () => {
	it('records no_changes for an empty dry run and returns the run id header', async () => {
		vi.mocked(computeConfigPlan).mockReturnValue(EMPTY_PLAN);

		const res = await apply({ dryRun: true });

		expect(res.status).toBe(200);

		const record = expectOneRecord({
			result: 'no_changes',
			dryRun: true,
			destructive: false,
			changes: { create: 0, update: 0, delete: 0 },
		});

		expect(res.headers[HEADER]).toBe(record.runId);
		expect(record).not.toHaveProperty('errorCode');
	});

	it('records planned for a dry run with changes', async () => {
		const res = await apply({ dryRun: true });

		expect(res.status).toBe(200);
		expectOneRecord({ result: 'planned', dryRun: true, changes: { create: 1, update: 0, delete: 0 } });
	});

	it('records applied after a mutating apply', async () => {
		const res = await apply({ destructive: true });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ data: APPLY_RESULT, meta: { plan: SERIALIZED } });

		const record = expectOneRecord({
			result: 'applied',
			dryRun: false,
			destructive: true,
			changes: { create: 1, update: 0, delete: 0 },
		});

		expect(res.headers[HEADER]).toBe(record.runId);
	});

	it('records no_changes for a mutating apply of an empty plan', async () => {
		vi.mocked(computeConfigPlan).mockReturnValue(EMPTY_PLAN);

		const res = await apply();

		expect(res.status).toBe(200);
		expectOneRecord({ result: 'no_changes', dryRun: false });
	});

	it.each([
		['CONFIG_PROTECTED_RECORD', () => new ConfigProtectedRecordException('protected'), 400],
		['DESTRUCTIVE_CHANGES_REQUIRED', () => new DestructiveChangesRequiredException('deletions'), 400],
	])('records refused with %s and keeps the run id on the error response', async (code, make, status) => {
		vi.mocked(applyConfigPlan).mockRejectedValue(make());

		const res = await apply();

		expect(res.status).toBe(status);
		expect(res.body.errors[0].extensions.code).toBe(code);
		const record = expectOneRecord({ result: 'refused', errorCode: code });
		expect(res.headers[HEADER]).toBe(record.runId);
	});

	it('records invalid with the first failure code and no change counts', async () => {
		vi.mocked(validateDesiredConfig).mockReturnValue([
			{ code: 'CONFIG_IDENTITY_CONFLICT', message: 'first' },
			{ code: 'CONFIG_INVALID', message: 'second' },
		]);

		const res = await apply();

		expect(res.status).toBe(400);
		const record = expectOneRecord({ result: 'invalid', errorCode: 'CONFIG_IDENTITY_CONFLICT' });
		expect(record).not.toHaveProperty('changes');
		expect(res.headers[HEADER]).toBe(record.runId);
	});

	it('records state_changed on a 409', async () => {
		vi.mocked(applyConfigPlan).mockRejectedValue(new ConfigStateChangedException());

		const res = await apply();

		expect(res.status).toBe(409);
		expectOneRecord({ result: 'state_changed', errorCode: 'CONFIG_STATE_CHANGED' });
	});

	it('records post_apply_failed on a post-commit failure', async () => {
		vi.mocked(applyConfigPlan).mockRejectedValue(new ConfigPostCommitFailedException());

		const res = await apply();

		expect(res.status).toBe(500);
		expectOneRecord({ result: 'post_apply_failed', errorCode: 'CONFIG_POST_COMMIT_FAILED' });
	});

	it('records failed with UNEXPECTED on an untyped throw and keeps the run id on the 500', async () => {
		vi.mocked(applyConfigPlan).mockRejectedValue(new Error('boom'));

		const res = await apply();

		expect(res.status).toBe(500);
		const record = expectOneRecord({ result: 'failed', errorCode: 'UNEXPECTED' });
		expect(res.headers[HEADER]).toBe(record.runId);
	});

	it('records failed with UNEXPECTED for a BaseException with a novel code', async () => {
		vi.mocked(applyConfigPlan).mockRejectedValue(new BaseException(`${MARKER}${BEL}`, 500, `${MARKER}${BEL}`));

		await apply();

		const record = expectOneRecord({ result: 'failed', errorCode: 'UNEXPECTED' });
		expect(JSON.stringify(record)).not.toContain(MARKER);
	});

	it.each(['pretty', 'raw'])('emits the record under the %s log style', async (style) => {
		envOverrides['LOG_STYLE'] = style;

		const res = await apply();

		expect(res.status).toBe(200);
		expectOneRecord({ result: 'applied' });
	});

	it('records the user agent bounded and neutralized', async () => {
		const tab = String.fromCharCode(9);
		const nextLine = String.fromCharCode(0x85);
		const res = await apply({ userAgent: `${MARKER}${tab}${nextLine}${'a'.repeat(100)}` });

		expect(res.status).toBe(200);
		const record = expectOneRecord({ result: 'applied' });
		expect(record.userAgent).toContain(MARKER);
		expect(record.userAgent).not.toContain(tab);
		expect(record.userAgent).not.toContain(nextLine);
		expect(record.userAgent!.length).toBeLessThanOrEqual(64 + '...'.length);
	});

	it('omits the user agent when the header is empty', async () => {
		await apply({ userAgent: '' });

		expect(expectOneRecord({ result: 'applied' })).not.toHaveProperty('userAgent');
	});

	it('records a UUID accountability as the user caller and never the ip', async () => {
		await apply();

		const record = expectOneRecord({ result: 'applied', caller: { kind: 'user', user: USER, role: ROLE } });
		expect(JSON.stringify(record)).not.toContain('10.0.0.1');
	});

	it('falls back to the request caller for a filter-supplied non-UUID accountability', async () => {
		await apply({ accountability: { ...ADMIN, user: `${MARKER}${BEL}` } });

		const record = expectOneRecord({ result: 'applied', caller: { kind: 'request' } });
		expect(JSON.stringify(record)).not.toContain(MARKER);
	});

	it('emits no record and no run id for a non-admin', async () => {
		const res = await apply({ accountability: { admin: false } });

		expect(res.status).toBe(403);
		expect(records()).toHaveLength(0);
		expect(res.headers[HEADER]).toBeUndefined();
	});

	it('emits no record and no run id for an unsupported media type', async () => {
		const res = await request(makeApp(ADMIN))
			.post('/config/apply')
			.set('Content-Type', 'text/plain')
			.send('manifest: {}');

		expect(res.status).toBe(415);
		expect(records()).toHaveLength(0);
		expect(res.headers[HEADER]).toBeUndefined();
	});

	it('emits no record and no run id for an unsupported manifest version', async () => {
		const res = await request(makeApp(ADMIN))
			.post('/config/apply')
			.send({ ...BODY, manifest: { version: 2, resources: ['roles'] } });

		expect(res.status).toBe(400);
		expect(records()).toHaveLength(0);
		expect(res.headers[HEADER]).toBeUndefined();
	});

	it('leaves the status and envelope unchanged when the logger throws on the record', async () => {
		vi.mocked(logger.info).mockImplementation((payload: unknown) => {
			if ((payload as ConfigRunRecord | undefined)?.event === CONFIG_RUN_EVENT) throw new Error('sink down');
		});

		const res = await apply();

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ data: APPLY_RESULT, meta: { plan: SERIALIZED } });
	});
});

describe('POST /config/apply flag parsing', () => {
	function applyWithQuery(query: string) {
		return request(makeApp(ADMIN)).post(`/config/apply?${query}`).set('User-Agent', 'cairncms-cli/1.6.0').send(BODY);
	}

	it.each([
		['a numeric value', 'dry_run=1'],
		['a capitalized value', 'dry_run=True'],
		['an empty value', 'dry_run='],
		['an object value', 'dry_run[x]=true'],
		['a repeated value', 'dry_run=true&dry_run=true'],
		['an unknown word', 'dry_run=yes'],
	])('rejects %s for dry_run before any state is read', async (_label, query) => {
		const res = await applyWithQuery(query);

		expect(res.status).toBe(400);
		expect(res.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
		expect(readCurrentConfig).not.toHaveBeenCalled();
		expect(applyConfigPlan).not.toHaveBeenCalled();
		expect(records()).toHaveLength(0);
		expect(res.headers[HEADER]).toBeUndefined();
	});

	it.each([
		['a numeric value', 'destructive=1'],
		['a capitalized value', 'destructive=True'],
		['an empty value', 'destructive='],
		['a repeated value', 'destructive=true&destructive=false'],
	])('rejects %s for destructive before any state is read', async (_label, query) => {
		const res = await applyWithQuery(query);

		expect(res.status).toBe(400);
		expect(res.body.errors[0].extensions.code).toBe('CONFIG_INVALID');
		expect(readCurrentConfig).not.toHaveBeenCalled();
		expect(applyConfigPlan).not.toHaveBeenCalled();
		expect(records()).toHaveLength(0);
		expect(res.headers[HEADER]).toBeUndefined();
	});

	it('treats an exact false as a mutating apply', async () => {
		const res = await applyWithQuery('dry_run=false&destructive=false');

		expect(res.status).toBe(200);
		expect(applyConfigPlan).toHaveBeenCalledTimes(1);
		expectOneRecord({ result: 'applied', dryRun: false, destructive: false });
	});

	it('treats an exact true as a dry run', async () => {
		const res = await applyWithQuery('dry_run=true&destructive=true');

		expect(res.status).toBe(200);
		expect(applyConfigPlan).not.toHaveBeenCalled();
		expectOneRecord({ result: 'planned', dryRun: true, destructive: true });
	});
});

describe('current-state read failures', () => {
	const ORPHAN_MESSAGE =
		'Config snapshot could not read the permissions table: one or more permission rows reference a role that does not exist, so the database needs repair before the current state can be read.';

	beforeEach(() => {
		vi.mocked(readCurrentConfig).mockRejectedValue(new ConfigReadFailedException(ORPHAN_MESSAGE));
	});

	it('returns CONFIG_READ_FAILED from GET /config/snapshot with the non-identifying message', async () => {
		const res = await request(makeApp(ADMIN)).get('/config/snapshot');

		expect(res.status).toBe(500);
		expect(res.body.errors).toHaveLength(1);
		expect(res.body.errors[0]).toMatchObject({ message: ORPHAN_MESSAGE, extensions: { code: 'CONFIG_READ_FAILED' } });
	});

	it('returns CONFIG_READ_FAILED from POST /config/apply without planning or applying', async () => {
		const res = await apply();

		expect(res.status).toBe(500);
		expect(res.body.errors).toHaveLength(1);
		expect(res.body.errors[0]).toMatchObject({ message: ORPHAN_MESSAGE, extensions: { code: 'CONFIG_READ_FAILED' } });
		expect(computeConfigPlan).not.toHaveBeenCalled();
		expect(applyConfigPlan).not.toHaveBeenCalled();
		expectOneRecord({ result: 'failed', errorCode: 'CONFIG_READ_FAILED' });
	});
});
