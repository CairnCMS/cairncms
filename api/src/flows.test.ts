import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { BaseException } from '@cairncms/exceptions';
import { REDACT_TEXT } from './constants.js';
import * as exceptions from './exceptions/index.js';
import { buildRevisionData, getFlowManager, type Step } from './flows.js';
import conditionOp from './operations/condition/index.js';
import logOp from './operations/log/index.js';
import execOp from './operations/exec/index.js';
import getDatabase from './database/index.js';

const { checkAccessSpy, revisionsCreateSpy, encryptionKey, logSpy, envOverrides } = vi.hoisted(() => ({
	checkAccessSpy: vi.fn(),
	revisionsCreateSpy: vi.fn(),
	encryptionKey: { value: undefined as string | undefined },
	logSpy: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		debug: vi.fn(),
		log: vi.fn(),
	},
	envOverrides: {} as Record<string, unknown>,
}));

vi.mock('./logger.js', () => ({ default: logSpy }));

vi.mock('./env.js', async (importOriginal) => {
	const actual = (await importOriginal()) as { default: Record<string, unknown>; [key: string]: unknown };

	return {
		...actual,
		default: new Proxy(actual.default, {
			get: (target, prop) => {
				if (prop === 'SECRETS_ENCRYPTION_KEY') return encryptionKey.value;
				if (typeof prop === 'string' && prop in envOverrides) return envOverrides[prop];
				return target[prop as string];
			},
			has: (target, prop) => (typeof prop === 'string' && prop in envOverrides) || prop in target,
		}),
	};
});

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

	test('redacts a confined operation reference value, its minted handle, and the reference key', () => {
		const secret = 'sk_live_confined_reference_secret_value';
		const handle = 'cairn-secret-ref-abc123';

		// The flow data after a confined operation (top-level or a bundle entry) ran with a
		// reference option: a step option carries the configured secret under the declared
		// reference key, and the operation output echoes the minted handle the guest held.
		const keyedData = makeKeyedData({});
		keyedData['secret-op'] = { echoedHandle: handle, marker: 'ran' };

		const steps: Step[] = [
			{ operation: 'op-1', key: 'secret-op', status: 'resolve', options: { apiKey: secret, note: 'plain' } },
		];

		// The runner returns the resolved secret and the minted handle as redaction values,
		// and the descriptor's declared reference keys drive key-redaction.
		const result = buildRevisionData(steps, keyedData, [secret, handle], new Set(['apiKey']));
		const serialized = JSON.stringify(result);

		// Neither the resolved secret nor the minted handle persists anywhere in the revision.
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain(handle);

		// The declared reference key is key-redacted; the plain sibling option is preserved.
		const step = result.steps[0] as Step;
		expect((step.options as Record<string, unknown>)['apiKey']).toBe(REDACT_TEXT);
		expect((step.options as Record<string, unknown>)['note']).toBe('plain');
	});

	test('redacts an allowlisted $env value carried into a step option', () => {
		const envSecret = 'sk_live_env_secret_value_1234';
		const keyedData = makeKeyedData({});
		keyedData['$env'] = { STRIPE_KEY: envSecret };

		const steps: Step[] = [
			{ operation: 'op-1', key: 'call', status: 'resolve', options: { message: `charge with ${envSecret}` } },
		];

		const result = buildRevisionData(steps, keyedData);
		const serialized = JSON.stringify(result);

		expect(serialized).not.toContain(envSecret);
		expect((result.data as any).$env.STRIPE_KEY).toBe(REDACT_TEXT);
	});

	test('redacts an allowlisted $env value but preserves an unrelated arbitrary value', () => {
		const envSecret = 'sk_live_env_secret_value_1234';
		const ordinary = 'ordinary-non-secret-value-5678';
		const keyedData = makeKeyedData({});
		keyedData['$env'] = { STRIPE_KEY: envSecret };
		keyedData['fetch'] = { note: ordinary };

		const steps: Step[] = [
			{ operation: 'op-1', key: 'render', status: 'resolve', options: { message: `${envSecret} and ${ordinary}` } },
		];

		const serialized = JSON.stringify(buildRevisionData(steps, keyedData));

		expect(serialized).not.toContain(envSecret);
		expect(serialized).toContain(ordinary);
	});

	test('redacts a short allowlisted $env value rather than leaving it in cleartext', () => {
		const shortSecret = 'pin-8842';
		const keyedData = makeKeyedData({});
		keyedData['$env'] = { PIN: shortSecret };

		const steps: Step[] = [
			{ operation: 'op-1', key: 'render', status: 'resolve', options: { message: `code ${shortSecret} sent` } },
		];

		expect(JSON.stringify(buildRevisionData(steps, keyedData))).not.toContain(shortSecret);
	});

	test('redacts an allowlisted $env value the env parser coerced to a number', () => {
		const keyedData = makeKeyedData({});
		keyedData['$env'] = { PIN: 123456 };

		const steps: Step[] = [
			{ operation: 'op-1', key: 'render', status: 'resolve', options: { message: 'code 123456 sent' } },
		];

		const result = buildRevisionData(steps, keyedData);

		expect(JSON.stringify(result)).not.toContain('123456');
		expect((result.data as any).$env.PIN).toBe(REDACT_TEXT);
	});

	test('redacts a nested leaf of a json-typed allowlisted $env value', () => {
		const nestedSecret = 'nested_env_secret_value_1234';
		const keyedData = makeKeyedData({});
		keyedData['$env'] = { SERVICE_CONFIG: { private_key: nestedSecret, region: 'us-east-1' } };

		const steps: Step[] = [
			{
				operation: 'op-1',
				key: 'render',
				status: 'resolve',
				options: { message: `authenticating with ${nestedSecret}` },
			},
		];

		const serialized = JSON.stringify(buildRevisionData(steps, keyedData));

		expect(serialized).not.toContain(nestedSecret);
		expect((JSON.parse(serialized).data.$env.SERVICE_CONFIG as any).private_key).toBe(REDACT_TEXT);
	});

	test('handles a cyclic allowlisted $env value without looping', () => {
		const keyedData = makeKeyedData({});
		const cyclic: Record<string, unknown> = { name: 'config' };
		cyclic['self'] = cyclic;
		keyedData['$env'] = { CFG: cyclic };

		const steps: Step[] = [{ operation: 'op-1', key: 'render', status: 'resolve', options: { message: 'ok' } }];

		expect(() => buildRevisionData(steps, keyedData)).not.toThrow();
	});

	test('does not collect the bytes of a non-plain allowlisted $env value', () => {
		const keyedData = makeKeyedData({});
		keyedData['$env'] = { BIN: Buffer.from([104, 105]) };

		const steps: Step[] = [
			{ operation: 'op-1', key: 'render', status: 'resolve', options: { message: 'count 104 items', code: 105 } },
		];

		const result = buildRevisionData(steps, keyedData);

		expect(JSON.stringify(result)).toContain('count 104 items');
		expect((result.steps[0] as any).options.code).toBe(105);
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

describe('executeFlow — confined operation reference redaction reaches the revision sink', () => {
	beforeEach(() => {
		revisionsCreateSpy.mockReset();
		getFlowManager().clearConfinedOperations();
	});

	test('the persisted revision carries neither the secret, the handle, nor a nested sensitive value under the reference key', async () => {
		const rawSecret = 'sk_live_confined_flow_secret_value';
		const handle = 'cairn-secret-ref-xyz789';

		const manager = getFlowManager();

		// A confined operation descriptor as the bundle binding registers one: the declared
		// reference keys drive key-redaction, and the run returns the resolved secret and the
		// minted handle as the redaction values a real runner produces.
		manager.addConfinedOperation('confined-secret-op', {
			referenceKeys: ['apiKey'],
			run: async () => ({
				outcome: { ok: true, value: { echoedHandle: handle } },
				redactionValues: [rawSecret, handle],
			}),
		});

		const flow = {
			id: 'secret-flow',
			name: 'secret-flow',
			status: 'active',
			trigger: 'webhook',
			// Only accountability 'all' persists a revision, so this drives the real sink.
			accountability: 'all',
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-1',
				key: 'run-secret',
				type: 'confined-secret-op',
				options: { apiKey: rawSecret, note: 'plain', audit: { token: rawSecret } },
				resolve: null,
				reject: null,
			},
		};

		const context = {
			accountability: { user: 'u-1', role: 'r-1', admin: true, ip: '127.0.0.1' },
			database: {} as any,
			schema: { collections: {}, relations: [] } as any,
		};

		await (manager as any).executeFlow(flow, { x: 1 }, context);

		expect(revisionsCreateSpy).toHaveBeenCalledTimes(1);

		const revision = revisionsCreateSpy.mock.calls[0]![0] as { data: { steps: Step[]; data: Record<string, unknown> } };
		const serialized = JSON.stringify(revision.data);

		// The real flow collected the descriptor's referenceKeys and the runner's redaction
		// values and passed them to the sink, so neither persists anywhere in the revision.
		expect(serialized).not.toContain(rawSecret);
		expect(serialized).not.toContain(handle);

		const step = revision.data.steps[0] as Step;

		// Key-redaction of the declared reference key.
		expect((step.options as Record<string, unknown>)['apiKey']).toBe(REDACT_TEXT);

		// Value-redaction of the same secret echoed into a non-sensitive-keyed nested option.
		expect((step.options as Record<string, any>)['audit']['token']).toBe(REDACT_TEXT);

		// A non-sensitive option is preserved.
		expect((step.options as Record<string, unknown>)['note']).toBe('plain');
	});
});

describe('executeFlow — confined operation envelopes decrypt before interpolation', () => {
	beforeEach(() => {
		encryptionKey.value = Buffer.alloc(32, 5).toString('base64');
		getFlowManager().clearConfinedOperations();
	});

	async function runWithStoredOption(storedValue: unknown): Promise<Record<string, unknown>> {
		const manager = getFlowManager();
		let received: Record<string, unknown> = {};

		manager.addConfinedOperation('envelope-op', {
			referenceKeys: ['apiKey'],
			run: async ({ options }: { options: Record<string, unknown> }) => {
				received = options;
				return { outcome: { ok: true, value: null }, redactionValues: [] };
			},
		} as any);

		const flow = {
			id: 'envelope-flow',
			name: 'envelope-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-env-1',
				key: 'run-envelope',
				type: 'envelope-op',
				options: { apiKey: storedValue, note: 'plain' },
				resolve: null,
				reject: null,
			},
		};

		const context = {
			accountability: null,
			database: {} as any,
			schema: { collections: {}, relations: [] } as any,
		};

		await (getFlowManager() as any).executeFlow(flow, { suffix: 'A1' }, context);

		return received;
	}

	test('a stored envelope decrypts and its templated cleartext interpolates before the handler', async () => {
		const { encryptSecret } = await import('./utils/encrypt-secret.js');
		const envelope = await encryptSecret('sk_live_{{$trigger.suffix}}');

		const received = await runWithStoredOption(envelope);

		expect(received['apiKey']).toBe('sk_live_A1');
		expect(received['note']).toBe('plain');
	});

	test('a tampered envelope never resolves to plaintext', async () => {
		const { encryptSecret, hasSecretMarker } = await import('./utils/encrypt-secret.js');
		const envelope: any = await encryptSecret('sk_live_secret');
		const tampered = { ...envelope, ct: Buffer.from('tampered').toString('base64') };

		const received = await runWithStoredOption(tampered);

		expect(hasSecretMarker(received['apiKey'])).toBe(true);
		expect(JSON.stringify(received)).not.toContain('sk_live_secret');
	});

	test('a plaintext value under a declared key never reaches the handler as a usable string', async () => {
		const received = await runWithStoredOption('sk_live_plaintext_at_rest');

		expect(typeof received['apiKey']).not.toBe('string');
		expect(JSON.stringify(received)).not.toContain('sk_live_plaintext_at_rest');
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

describe('confined operation binding', () => {
	const triggerData = { path: '/x', method: 'POST', headers: {}, query: {}, body: {} };
	const context = { accountability: null, database: {} as any, schema: { collections: {}, relations: [] } as any };

	function confinedFlow(type: string, options: Record<string, unknown> = {}, accountability: unknown = null): any {
		return {
			id: 'flow-c',
			name: 'flow-c',
			status: 'active',
			trigger: 'webhook',
			accountability,
			options: { method: 'POST', return: '$last', async: false },
			operation: { id: 'op-row-9', key: 'step', type, options, resolve: null, reject: null },
		};
	}

	beforeEach(() => {
		const manager = getFlowManager();
		manager.clearOperations();
		manager.clearConfinedOperations();
	});

	it('runs a confined operation through its descriptor with $last input and resolved options', async () => {
		const manager = getFlowManager();
		let seen: { operationId: string; options: unknown; input: unknown } | undefined;

		manager.addConfinedOperation('confined-op', {
			referenceKeys: [],
			run: async (params) => {
				seen = params;
				return { outcome: { ok: true, value: { done: true } }, redactionValues: [] };
			},
		});

		const result = await (manager as any).executeFlow(
			confinedFlow('confined-op', { channel: 'general' }),
			{ last: 'x' },
			context
		);

		expect(result).toEqual({ done: true });
		expect(seen?.operationId).toBe('op-row-9');
		expect(seen?.options).toEqual({ channel: 'general' });
		expect(seen?.input).toEqual({ last: 'x' });
	});

	it('keeps an inherited operation running after the Map registry change', async () => {
		const manager = getFlowManager();
		manager.addOperation('inherited-op', (() => ({ ran: true })) as any);

		const result = await (manager as any).executeFlow(confinedFlow('inherited-op'), triggerData, context);
		expect(result).toEqual({ ran: true });
	});

	it('rejects an ambiguous duplicate confined id without running either', async () => {
		const manager = getFlowManager();
		let runs = 0;

		const descriptor = {
			referenceKeys: [],
			run: async () => {
				runs++;
				return { outcome: { ok: true as const, value: 1 }, redactionValues: [] };
			},
		};

		manager.addConfinedOperation('dup', descriptor);
		manager.addConfinedOperation('dup', descriptor);

		const result = await (manager as any).executeFlow(confinedFlow('dup'), triggerData, context);

		expect(result).toMatchObject({ message: expect.stringContaining('could not be resolved') });
		expect(runs).toBe(0);
	});

	it('rejects a type declared by both an inherited and a confined extension', async () => {
		const manager = getFlowManager();
		let inheritedRan = false;
		let confinedRan = false;

		manager.addOperation('collide', (() => {
			inheritedRan = true;
			return {};
		}) as any);

		manager.addConfinedOperation('collide', {
			referenceKeys: [],
			run: async () => {
				confinedRan = true;
				return { outcome: { ok: true as const, value: 1 }, redactionValues: [] };
			},
		});

		const result = await (manager as any).executeFlow(confinedFlow('collide'), triggerData, context);

		expect(result).toMatchObject({ message: expect.stringContaining('could not be resolved') });
		expect(inheritedRan).toBe(false);
		expect(confinedRan).toBe(false);
	});

	it('treats a constructor-named operation type as unknown, not an object prototype member', async () => {
		const manager = getFlowManager();
		const result = await (manager as any).executeFlow(confinedFlow('constructor'), triggerData, context);
		expect(result).toBeNull();
	});

	it('redacts the configured secret, the handle, and a value nested under a camelCase declared key', async () => {
		const manager = getFlowManager();

		manager.addConfinedOperation('redact-op', {
			referenceKeys: ['apiKey', 'webhookConfig'],
			run: async () => ({
				outcome: { ok: true as const, value: { echoedHandle: 'handle-ref-abc', note: 'used sk_live_secret today' } },
				redactionValues: ['sk_live_secret', 'handle-ref-abc'],
			}),
		});

		revisionsCreateSpy.mockClear();

		await (manager as any).executeFlow(
			confinedFlow('redact-op', { apiKey: 'sk_live_secret', webhookConfig: { token: 'nested_secret' } }, 'all'),
			triggerData,
			context
		);

		const serialized = JSON.stringify(revisionsCreateSpy.mock.calls[0]![0].data);
		expect(serialized).not.toContain('sk_live_secret');
		expect(serialized).not.toContain('handle-ref-abc');
		expect(serialized).not.toContain('nested_secret');
	});
});

describe('executeFlow — trusted log and exec operations redact secrets in live output', () => {
	beforeEach(() => {
		logSpy.info.mockReset();
		(getDatabase as any).mockReset();
		(getDatabase as any).mockImplementation(() => ({}));
		getFlowManager().clearOperations();
		getFlowManager().clearConfinedOperations();
		for (const key of Object.keys(envOverrides)) delete envOverrides[key];
	});

	const flowContext = {
		accountability: { user: 'u-1', role: 'r-1', admin: true, ip: '127.0.0.1' },
		database: {} as any,
		schema: { collections: {}, relations: [] } as any,
	};

	function confinedThenOp(secondOp: Record<string, unknown>) {
		return {
			id: 'live-log-flow',
			name: 'live-log-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-1',
				key: 'secretstep',
				type: 'confined-secret-op',
				options: {},
				resolve: secondOp,
				reject: null,
			},
		};
	}

	test('a trusted Log to Console step redacts a confined secret while preserving surrounding text', async () => {
		const rawSecret = 'sk_live_confined_log_secret_value';
		const manager = getFlowManager();

		manager.addOperation('log', logOp.handler as any, true);

		manager.addConfinedOperation('confined-secret-op', {
			referenceKeys: ['apiKey'],
			run: async () => ({
				outcome: { ok: true as const, value: { result: rawSecret } },
				redactionValues: [rawSecret],
			}),
		});

		const flow = confinedThenOp({
			id: 'op-2',
			key: 'logstep',
			type: 'log',
			options: { message: 'before {{ secretstep.result }} after' },
			resolve: null,
			reject: null,
		});

		await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(logSpy.info).toHaveBeenCalledWith(`before ${REDACT_TEXT} after`);
	});

	test('a trusted Log step key-redacts a camelCase reference key whose value is not in the value set', async () => {
		const marker = 'plain-marker-not-a-declared-value';
		const manager = getFlowManager();

		manager.addOperation('log', logOp.handler as any, true);

		manager.addConfinedOperation('confined-secret-op', {
			referenceKeys: ['apiKey'],
			run: async () => ({
				outcome: { ok: true as const, value: { apiKey: marker, keep: 'ok' } },
				redactionValues: [],
			}),
		});

		const flow = confinedThenOp({
			id: 'op-2',
			key: 'logstep',
			type: 'log',
			options: { message: '{{ secretstep }}' },
			resolve: null,
			reject: null,
		});

		await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(logSpy.info).toHaveBeenCalledWith(JSON.stringify({ apiKey: REDACT_TEXT, keep: 'ok' }));
	});

	test('a trusted log operation receives the redactForFlowLog capability', async () => {
		let captured: Record<string, unknown> | null = null;
		const manager = getFlowManager();

		manager.addOperation(
			'log',
			((_options: unknown, context: Record<string, unknown>) => {
				captured = context;
				return null;
			}) as any,
			true
		);

		const flow = {
			id: 'capture-flow',
			name: 'capture-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: { id: 'op-1', key: 'logstep', type: 'log', options: { message: 'hi' }, resolve: null, reject: null },
		};

		await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(typeof (captured as any)?.redactForFlowLog).toBe('function');
	});

	test('a log operation registered without the trusted flag does not receive the redactor', async () => {
		let captured: Record<string, unknown> | null = null;
		const manager = getFlowManager();

		manager.addOperation('log', ((_options: unknown, context: Record<string, unknown>) => {
			captured = context;
			return null;
		}) as any);

		const flow = {
			id: 'shadow-flow',
			name: 'shadow-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: { id: 'op-1', key: 'logstep', type: 'log', options: { message: 'hi' }, resolve: null, reject: null },
		};

		await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(captured).not.toBeNull();
		expect((captured as any)?.redactForFlowLog).toBeUndefined();
	});

	test('a downstream non-gated operation context carries no raw confined redaction values', async () => {
		const rawSecret = 'sk_live_confined_isolation_secret';
		let captured: Record<string, unknown> | null = null;
		const manager = getFlowManager();

		manager.addConfinedOperation('confined-secret-op', {
			referenceKeys: ['apiKey'],
			run: async () => ({
				outcome: { ok: true as const, value: { result: rawSecret } },
				redactionValues: [rawSecret],
			}),
		});

		manager.addOperation(
			'capture',
			((_options: unknown, context: Record<string, unknown>) => {
				captured = context;
				return null;
			}) as any,
			true
		);

		const flow = confinedThenOp({
			id: 'op-2',
			key: 'capturestep',
			type: 'capture',
			options: {},
			resolve: null,
			reject: null,
		});

		await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(captured).not.toBeNull();
		const contextWithoutKeyedData: Record<string, unknown> = { ...(captured as Record<string, unknown>) };
		delete contextWithoutKeyedData['data'];
		expect(JSON.stringify(contextWithoutKeyedData)).not.toContain(rawSecret);

		expect(captured).not.toHaveProperty('redactionValues');
		expect(captured).not.toHaveProperty('redactionKeys');
		expect((captured as any)?.redactForFlowLog).toBeUndefined();
	});

	test('redacts an allowlisted $env value referenced in a Log to Console message', async () => {
		const envSecret = 'sk_live_env_secret_value_1234';
		envOverrides['FLOWS_ENV_ALLOW_LIST'] = 'STRIPE_KEY';
		envOverrides['STRIPE_KEY'] = envSecret;

		const manager = getFlowManager();
		manager.addOperation('log', logOp.handler as any, true);

		const flow = {
			id: 'env-log-flow',
			name: 'env-log-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-1',
				key: 'logstep',
				type: 'log',
				options: { message: 'charging {{ $env.STRIPE_KEY }} now' },
				resolve: null,
				reject: null,
			},
		};

		await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(logSpy.info).toHaveBeenCalledWith('charging --redact-- now');
	});

	test('redacts an allowlisted $env value printed by a Run Script', async () => {
		const envSecret = 'sk_live_env_secret_value_1234';
		envOverrides['FLOWS_ENV_ALLOW_LIST'] = 'STRIPE_KEY';
		envOverrides['STRIPE_KEY'] = envSecret;

		const manager = getFlowManager();
		manager.addOperation('exec', execOp.handler as any, true);

		const flow = {
			id: 'env-exec-flow',
			name: 'env-exec-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-1',
				key: 'execstep',
				type: 'exec',
				options: {
					code: "module.exports = function () { console.log('charging ' + process.env.STRIPE_KEY + ' now'); return null; };",
				},
				resolve: null,
				reject: null,
			},
		};

		await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(logSpy.info).toHaveBeenCalledWith('charging --redact-- now');
	});

	test('redacts a numeric allowlisted $env value printed by a Run Script', async () => {
		envOverrides['FLOWS_ENV_ALLOW_LIST'] = 'PIN';
		envOverrides['PIN'] = 123456;

		const manager = getFlowManager();
		manager.addOperation('exec', execOp.handler as any, true);

		const flow = {
			id: 'env-exec-numeric-flow',
			name: 'env-exec-numeric-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-1',
				key: 'execstep',
				type: 'exec',
				options: {
					code: "module.exports = function () { console.log('code ' + process.env.PIN + ' sent'); return null; };",
				},
				resolve: null,
				reject: null,
			},
		};

		await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(logSpy.info).toHaveBeenCalledWith('code --redact-- sent');
	});

	test('redacts a nested leaf of a json-typed allowlisted $env value printed by a Run Script', async () => {
		const nestedSecret = 'nested_env_secret_value_1234';
		envOverrides['FLOWS_ENV_ALLOW_LIST'] = 'SERVICE_CONFIG';
		envOverrides['SERVICE_CONFIG'] = { private_key: nestedSecret };

		const manager = getFlowManager();
		manager.addOperation('exec', execOp.handler as any, true);

		const flow = {
			id: 'env-exec-json-flow',
			name: 'env-exec-json-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-1',
				key: 'execstep',
				type: 'exec',
				options: {
					code: "module.exports = function () { console.log('auth ' + process.env.SERVICE_CONFIG.private_key + ' done'); return null; };",
				},
				resolve: null,
				reject: null,
			},
		};

		await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(logSpy.info).toHaveBeenCalledWith('auth --redact-- done');
	});

	test('a throw during handler context construction follows the operation reject path', async () => {
		const manager = getFlowManager();
		manager.addOperation('log', logOp.handler as any, true);

		(getDatabase as any).mockImplementationOnce(() => {
			throw new Error('CONTEXT_CONSTRUCTION_BOOM');
		});

		const flow = {
			id: 'boundary-flow',
			name: 'boundary-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-1',
				key: 'logstep',
				type: 'log',
				options: { message: 'hi' },
				resolve: null,
				reject: null,
			},
		};

		const result = await (manager as any).executeFlow(flow, { x: 1 }, flowContext);

		expect(result).toEqual({ message: 'CONTEXT_CONSTRUCTION_BOOM' });
	});
});

describe('executeFlow — trusted Run Script redacts secrets in console output', () => {
	beforeEach(() => {
		logSpy.info.mockReset();
		getFlowManager().clearOperations();
		getFlowManager().clearConfinedOperations();
	});

	test('a trusted Run Script step redacts a confined secret printed via console.log', async () => {
		const rawSecret = 'sk_live_confined_exec_secret_value';
		const manager = getFlowManager();

		manager.addOperation('exec', execOp.handler as any, true);

		manager.addConfinedOperation('confined-secret-op', {
			referenceKeys: ['apiKey'],
			run: async () => ({
				outcome: { ok: true as const, value: { result: rawSecret } },
				redactionValues: [rawSecret],
			}),
		});

		const flow = {
			id: 'exec-flow',
			name: 'exec-flow',
			status: 'active',
			trigger: 'webhook',
			accountability: null,
			options: { method: 'POST', return: '$last', async: false },
			operation: {
				id: 'op-1',
				key: 'secretstep',
				type: 'confined-secret-op',
				options: {},
				resolve: {
					id: 'op-2',
					key: 'execstep',
					type: 'exec',
					options: {
						code: "module.exports = function (data) { console.log('before ' + data.secretstep.result + ' after'); return null; };",
					},
					resolve: null,
					reject: null,
				},
				reject: null,
			},
		};

		const context = {
			accountability: { user: 'u-1', role: 'r-1', admin: true, ip: '127.0.0.1' },
			database: {} as any,
			schema: { collections: {}, relations: [] } as any,
		};

		await (manager as any).executeFlow(flow, { x: 1 }, context);

		expect(logSpy.info).toHaveBeenCalledWith(`before ${REDACT_TEXT} after`);
	});
});
