import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { BaseException } from '@cairncms/exceptions';
import { REDACT_TEXT } from './constants.js';
import * as exceptions from './exceptions/index.js';
import { buildRevisionData, getFlowManager, type Step } from './flows.js';
import conditionOp from './operations/condition/index.js';

const { checkAccessSpy, revisionsCreateSpy } = vi.hoisted(() => ({
	checkAccessSpy: vi.fn(),
	revisionsCreateSpy: vi.fn(),
}));

vi.mock('./database/index.js', () => ({
	default: vi.fn(() => ({})),
}));

vi.mock('./services/authorization.js', () => {
	const AuthorizationService = vi.fn();
	AuthorizationService.prototype.checkAccess = checkAccessSpy;
	return { AuthorizationService };
});

vi.mock('./services/activity.js', () => {
	const ActivityService = vi.fn();
	ActivityService.prototype.createOne = vi.fn().mockResolvedValue('test-activity-id');
	return { ActivityService };
});

vi.mock('./services/revisions.js', () => {
	const RevisionsService = vi.fn();
	RevisionsService.prototype.createOne = revisionsCreateSpy;
	return { RevisionsService };
});

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.HEADER_PAYLOAD_LONG_ENOUGH_TO_BE_REAL_TOKEN';

function makeKeyedData(triggerOverrides: Record<string, unknown>): Record<string, unknown> {
	const trigger = {
		path: '/flows/trigger/abc',
		method: 'POST',
		headers: {},
		query: {},
		body: {},
		...triggerOverrides,
	};

	return {
		$trigger: trigger,
		$last: trigger,
		$accountability: null,
		$env: {},
	};
}

describe('buildRevisionData', () => {
	test('redacts Authorization header in $trigger.headers and preserves other trigger fields', () => {
		const keyedData = makeKeyedData({ headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' } });
		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.headers.authorization).toBe(REDACT_TEXT);
		expect(trigger.headers.accept).toBe('application/json');
		expect(trigger.method).toBe('POST');
		expect(trigger.path).toBe('/flows/trigger/abc');
	});

	test('redacts refresh-token cookie in $trigger.headers and preserves other trigger fields', () => {
		const keyedData = makeKeyedData({
			headers: { cookie: `cairncms_refresh_token=${TOKEN}; other=value` },
		});

		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.headers.cookie).toBe(REDACT_TEXT);
		expect(trigger.method).toBe('POST');
		expect(trigger.path).toBe('/flows/trigger/abc');
	});

	test('redacts access_token in $trigger.query', () => {
		const keyedData = makeKeyedData({ query: { access_token: TOKEN, page: '1' } });
		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.query.access_token).toBe(REDACT_TEXT);
		expect(trigger.query.page).toBe('1');
		expect(trigger.method).toBe('POST');
	});

	test('redacts refresh_token in $trigger.query', () => {
		const keyedData = makeKeyedData({ query: { refresh_token: TOKEN, page: '1' } });
		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.query.refresh_token).toBe(REDACT_TEXT);
		expect(trigger.query.page).toBe('1');
	});

	test('redacts access_token in $trigger.body', () => {
		const keyedData = makeKeyedData({ body: { access_token: TOKEN, action: 'sync' } });
		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.body.access_token).toBe(REDACT_TEXT);
		expect(trigger.body.action).toBe('sync');
		expect(trigger.method).toBe('POST');
	});

	test('redacts refresh_token in $trigger.body', () => {
		const keyedData = makeKeyedData({ body: { refresh_token: TOKEN, action: 'sync' } });
		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.body.refresh_token).toBe(REDACT_TEXT);
		expect(trigger.body.action).toBe('sync');
	});

	test('redacts password in $trigger.body and the same value interpolated into a step option', () => {
		const PASSWORD = 'webhook-supplied-password-1234567890';
		const keyedData = makeKeyedData({ body: { password: PASSWORD, action: 'sync' } });

		const steps: Step[] = [
			{
				operation: 'op-1',
				key: 'log-pw',
				status: 'resolve',
				options: { message: `Received password: ${PASSWORD}`, target: 'audit@example.com' },
			},
		];

		const result = buildRevisionData(steps, keyedData);
		const trigger = (result.data as any).$trigger;
		const step = result.steps[0] as Step;

		expect(trigger.body.password).toBe(REDACT_TEXT);
		expect(trigger.body.action).toBe('sync');
		expect(step.options).not.toBeNull();
		expect((step.options as Record<string, unknown>)['message']).not.toContain(PASSWORD);
		expect((step.options as Record<string, unknown>)['target']).toBe('audit@example.com');
	});

	test('redacts token value carried into a step option by template interpolation', () => {
		const keyedData = makeKeyedData({ body: { access_token: TOKEN } });

		const steps: Step[] = [
			{
				operation: 'op-1',
				key: 'send-notification',
				status: 'resolve',
				options: {
					message: TOKEN,
					target: 'user@example.com',
				},
			},
		];

		const result = buildRevisionData(steps, keyedData);
		const step = result.steps[0] as Step;

		expect(step.options).not.toBeNull();
		expect((step.options as Record<string, unknown>)['message']).toBe(REDACT_TEXT);
		expect((step.options as Record<string, unknown>)['target']).toBe('user@example.com');
		expect(step.operation).toBe('op-1');
		expect(step.key).toBe('send-notification');
		expect(step.status).toBe('resolve');
	});

	test('redacts a token produced by a prior step output and interpolated into a later step option', () => {
		const STEP_TOKEN = 'sk_live_step_output_token_value';
		const keyedData = makeKeyedData({});
		keyedData['fetch-token'] = { data: { access_token: STEP_TOKEN } };

		const steps: Step[] = [
			{
				operation: 'op-1',
				key: 'fetch-token',
				status: 'resolve',
				options: { url: 'https://internal/token' },
			},
			{
				operation: 'op-2',
				key: 'send-notification',
				status: 'resolve',
				options: {
					url: `https://hook.example.com/?key=${STEP_TOKEN}`,
					method: 'POST',
				},
			},
		];

		const result = buildRevisionData(steps, keyedData);
		const stepB = result.steps[1] as Step;

		expect(stepB.options).not.toBeNull();
		expect((stepB.options as Record<string, unknown>)['url']).toBe(`https://hook.example.com/?key=${REDACT_TEXT}`);
		expect((stepB.options as Record<string, unknown>)['method']).toBe('POST');
	});

	test('redacts a credential produced by a prior step output and interpolated into a later step message', () => {
		const STEP_CRED = 'super-secret-credential-value-1234';
		const keyedData = makeKeyedData({});
		keyedData['authenticate'] = { credentials: { password: STEP_CRED } };

		const steps: Step[] = [
			{
				operation: 'op-1',
				key: 'authenticate',
				status: 'resolve',
				options: { username: 'service-account' },
			},
			{
				operation: 'op-2',
				key: 'log-message',
				status: 'resolve',
				options: {
					message: `Authenticated with ${STEP_CRED}`,
					target: 'audit@example.com',
				},
			},
		];

		const result = buildRevisionData(steps, keyedData);
		const stepB = result.steps[1] as Step;

		expect(stepB.options).not.toBeNull();
		expect((stepB.options as Record<string, unknown>)['message']).toBe(`Authenticated with ${REDACT_TEXT}`);
		expect((stepB.options as Record<string, unknown>)['target']).toBe('audit@example.com');
	});

	test('does not redact non-sensitive-keyed step output values (regression — no false positives)', () => {
		const PROSE = 'an innocuous descriptive prose string';
		const keyedData = makeKeyedData({});
		keyedData['fetch-content'] = { data: { description: PROSE } };

		const steps: Step[] = [
			{
				operation: 'op-1',
				key: 'fetch-content',
				status: 'resolve',
				options: { url: 'https://internal/content' },
			},
			{
				operation: 'op-2',
				key: 'forward',
				status: 'resolve',
				options: { message: `Fetched: ${PROSE}` },
			},
		];

		const result = buildRevisionData(steps, keyedData);
		const stepB = result.steps[1] as Step;

		expect((stepB.options as Record<string, unknown>)['message']).toContain(PROSE);
	});
});

describe('executeFlow — webhook trigger with failing condition does not leak context into response', () => {
	test('the value returned from executeFlow when a condition fails contains no $accountability or $trigger.headers markers', async () => {
		const manager = getFlowManager();
		manager.addOperation('condition', conditionOp.handler as any);

		const flow = {
			id: 'test-flow',
			name: 'test-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-1',
				key: 'check',
				type: 'condition',
				options: { filter: { must_pass: { _eq: 'expected' } } },
				resolve: null,
				reject: null,
			},
		};

		const data = {
			path: '/flows/trigger/test',
			method: 'POST',
			headers: { authorization: 'Bearer TOKEN_MARKER_CCC_DO_NOT_LEAK' },
			query: {},
			body: { must_pass: 'actual' },
		};

		const context = {
			accountability: { user: 'USER_MARKER_BBB_DO_NOT_LEAK', role: 'role-id', admin: true, app: true, ip: '127.0.0.1' },
			database: {} as any,
			schema: { collections: {}, relations: [] } as any,
		};

		const result = await (manager as any).executeFlow(flow, data, context);
		const blob = JSON.stringify(result);

		expect(blob).not.toContain('TOKEN_MARKER_CCC_DO_NOT_LEAK');
		expect(blob).not.toContain('USER_MARKER_BBB_DO_NOT_LEAK');
	});
});

describe('FlowManager._runManualFlow (GHSA-7cvf-pxgp-42fc)', () => {
	const FLOW_ID = 'manual-flow-id';
	const TARGET_COLLECTION = 'articles';
	const TARGET_KEYS = ['article-1', 'article-2'];

	function buildFlow(overrides: { options?: Record<string, unknown> } = {}): any {
		return {
			id: FLOW_ID,
			name: 'Manual Flow',
			status: 'active',
			trigger: 'manual',
			accountability: null,
			options: { collections: [TARGET_COLLECTION], ...(overrides.options ?? {}) },
			operation: { id: 'op-1', key: 'log', type: 'log', options: {}, resolve: null, reject: null },
		};
	}

	function buildData(
		bodyOverrides: Record<string, unknown> = { collection: TARGET_COLLECTION, keys: TARGET_KEYS }
	): any {
		return {
			path: `/flows/trigger/${FLOW_ID}`,
			method: 'POST',
			headers: {},
			query: {},
			body: bodyOverrides,
		};
	}

	function buildContext(accountability: Record<string, unknown> | null): any {
		return { accountability, schema: { collections: {}, relations: [] } as any };
	}

	const anonAccountability = {
		user: null,
		role: null,
		admin: false,
		app: false,
		ip: '127.0.0.1',
		permissions: [] as any[],
	};

	const adminAccountability = {
		user: 'admin-uuid',
		role: 'role-uuid',
		admin: true,
		app: true,
		ip: '127.0.0.1',
		permissions: [] as any[],
	};

	const nonAdminWithItemRead = {
		user: 'user-uuid',
		role: 'role-uuid',
		admin: false,
		app: true,
		ip: '127.0.0.1',
		permissions: [{ collection: TARGET_COLLECTION, action: 'read', fields: ['*'] } as any],
	};

	let manager: any;
	let executeFlowSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		manager = getFlowManager();
		executeFlowSpy = vi.spyOn(manager, 'executeFlow').mockResolvedValue('executed' as any);
		checkAccessSpy.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('bug-exposing — caller without auth or permission is rejected', () => {
		it('rejects anonymous caller (accountability.user is null)', async () => {
			await expect(
				manager._runManualFlow(buildFlow(), buildData(), buildContext(anonAccountability))
			).rejects.toBeInstanceOf(exceptions.ForbiddenException);

			expect(executeFlowSpy).not.toHaveBeenCalled();
		});

		it('rejects when checkAccess on target items fails (keys path)', async () => {
			checkAccessSpy.mockImplementation(async (_action: any, collection: any) => {
				if (collection === TARGET_COLLECTION) throw new exceptions.ForbiddenException();
			});

			await expect(
				manager._runManualFlow(buildFlow(), buildData(), buildContext(nonAdminWithItemRead))
			).rejects.toBeInstanceOf(exceptions.ForbiddenException);

			expect(executeFlowSpy).not.toHaveBeenCalled();
		});

		it('rejects collection-mode trigger when caller lacks collection read', async () => {
			const flow = buildFlow({ options: { collections: [TARGET_COLLECTION], requireSelection: false } });
			const data = buildData({ collection: TARGET_COLLECTION });

			const nonAdminNoCollectionRead = {
				user: 'user-uuid',
				role: 'role-uuid',
				admin: false,
				app: true,
				ip: '127.0.0.1',
				permissions: [] as any[],
			};

			await expect(manager._runManualFlow(flow, data, buildContext(nonAdminNoCollectionRead))).rejects.toBeInstanceOf(
				exceptions.ForbiddenException
			);

			expect(executeFlowSpy).not.toHaveBeenCalled();
		});

		it('rejects when keys is absent and requireSelection is not false (defensive)', async () => {
			const flow = buildFlow();
			const data = buildData({ collection: TARGET_COLLECTION });

			await expect(manager._runManualFlow(flow, data, buildContext(adminAccountability))).rejects.toBeInstanceOf(
				exceptions.ForbiddenException
			);

			expect(executeFlowSpy).not.toHaveBeenCalled();
		});
	});

	describe('regression — authorized triggers execute', () => {
		it('admin caller with keys executes the flow', async () => {
			await manager._runManualFlow(buildFlow(), buildData(), buildContext(adminAccountability));
			expect(executeFlowSpy).toHaveBeenCalledTimes(1);
		});

		it('admin caller with no keys and requireSelection: false executes the flow', async () => {
			const flow = buildFlow({ options: { collections: [TARGET_COLLECTION], requireSelection: false } });
			const data = buildData({ collection: TARGET_COLLECTION });

			await manager._runManualFlow(flow, data, buildContext(adminAccountability));
			expect(executeFlowSpy).toHaveBeenCalledTimes(1);
		});

		it('triggers without directus_flows.read when caller has target-item read (Decision #18)', async () => {
			await manager._runManualFlow(buildFlow(), buildData(), buildContext(nonAdminWithItemRead));

			expect(executeFlowSpy).toHaveBeenCalledTimes(1);
			expect(checkAccessSpy).toHaveBeenCalledWith('read', TARGET_COLLECTION, TARGET_KEYS);
			expect(checkAccessSpy).not.toHaveBeenCalledWith('read', 'directus_flows', expect.anything());
		});

		it('non-admin with collection-level read executes collection-mode flow (no keys + requireSelection: false)', async () => {
			const flow = buildFlow({ options: { collections: [TARGET_COLLECTION], requireSelection: false } });
			const data = buildData({ collection: TARGET_COLLECTION });

			await manager._runManualFlow(flow, data, buildContext(nonAdminWithItemRead));
			expect(executeFlowSpy).toHaveBeenCalledTimes(1);
		});

		it('preserves the existing collection-allowlist check', async () => {
			const flow = buildFlow({ options: { collections: ['other-collection'] } });

			await expect(manager._runManualFlow(flow, buildData(), buildContext(adminAccountability))).rejects.toBeInstanceOf(
				exceptions.ForbiddenException
			);

			expect(executeFlowSpy).not.toHaveBeenCalled();
			expect(checkAccessSpy).not.toHaveBeenCalled();
		});
	});
});

describe('flow operation errors expose a curated reject payload', () => {
	const triggerData = { path: '/flows/trigger/err', method: 'POST', headers: {}, query: {}, body: {} };
	const context = { accountability: null, database: {} as any, schema: { collections: {}, relations: [] } as any };

	function throwingFlow(type: string): any {
		return {
			id: 'flow-err',
			name: 'flow-err',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: { id: 'op-1', key: 'fail', type, options: {}, resolve: null, reject: null },
		};
	}

	it('exposes message only when an operation throws a plain Error', async () => {
		const manager = getFlowManager();

		manager.addOperation('test-plain-error', () => {
			throw new Error('operation failed');
		});

		const result = await (manager as any).executeFlow(throwingFlow('test-plain-error'), triggerData, context);

		expect(result).toEqual({ message: 'operation failed' });
	});

	it('does not carry an Error cause into the reject payload', async () => {
		const manager = getFlowManager();

		manager.addOperation('test-error-cause', () => {
			throw new Error('operation failed', { cause: 'CAUSE_MARKER_MUST_NOT_SURVIVE' });
		});

		const result = await (manager as any).executeFlow(throwingFlow('test-error-cause'), triggerData, context);

		expect(result).toEqual({ message: 'operation failed' });
	});

	it('exposes message, code, status, and extensions when an operation throws a BaseException', async () => {
		const manager = getFlowManager();

		manager.addOperation('test-base-exception', () => {
			throw new BaseException('operation failed', 418, 'TEAPOT', { detail: 'context' });
		});

		const result = await (manager as any).executeFlow(throwingFlow('test-base-exception'), triggerData, context);

		expect(result).toEqual({
			message: 'operation failed',
			code: 'TEAPOT',
			status: 418,
			extensions: { detail: 'context' },
		});
	});

	it('persists only the curated error to the revision, without stack or cause', async () => {
		const secret = 'sk_live_must_not_persist_in_revision';
		const manager = getFlowManager();

		manager.addOperation('test-revision-error', () => {
			throw new Error('boom', { cause: secret });
		});

		revisionsCreateSpy.mockClear();

		await (manager as any).executeFlow(
			{ ...throwingFlow('test-revision-error'), accountability: 'all' },
			triggerData,
			context
		);

		expect(revisionsCreateSpy).toHaveBeenCalledTimes(1);

		const revisionData = revisionsCreateSpy.mock.calls[0]![0].data;
		expect(revisionData.data.$last).toEqual({ message: 'boom' });

		const serialized = JSON.stringify(revisionData);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain('stack');
		expect(serialized).not.toContain('cause');
	});
});
