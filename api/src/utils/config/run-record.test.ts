import { BaseException } from '@cairncms/exceptions';
import type { Accountability } from '@cairncms/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigKind } from '../../types/config.js';

const factoryEnv: Record<string, unknown> = {};

vi.mock('../../env.js', () => {
	const proxy = new Proxy(
		{},
		{
			get(_target, prop) {
				return factoryEnv[prop as string];
			},
		}
	);

	return { default: proxy, getEnv: () => proxy };
});

vi.mock('../../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const logger = (await import('../../logger.js')).default;

const {
	CONFIG_RUN_EVENT,
	CONFIG_RUN_MESSAGE,
	RUN_RECORD_ERROR_CODES,
	UNEXPECTED_ERROR_CODE,
	callerFromAccountability,
	classifyConfigError,
	emitConfigRunRecord,
	normalizeErrorCode,
	shouldEmit,
	systemCaller,
	userAgentFrom,
	withConfigRun,
} = await import('./run-record.js');

type ConfigRunRecord = import('./run-record.js').ConfigRunRecord;
type ConfigRunStart = import('./run-record.js').ConfigRunStart;

const MARKER = 'HOSTILE_MARKER_7f3a';
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CONTROL = `${ESC}[31m${BEL}\r\n`;
const USER = '0f0a3b1c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const ROLE = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const EXPECTED_RESULT: Record<string, string> = {
	CONFIG_INVALID: 'invalid',
	CONFIG_IDENTITY_CONFLICT: 'invalid',
	CONFIG_PROTECTED_RECORD: 'refused',
	DESTRUCTIVE_CHANGES_REQUIRED: 'refused',
	CONFIG_STATE_CHANGED: 'state_changed',
	CONFIG_POST_COMMIT_FAILED: 'post_apply_failed',
};

const CONFIG_EXCEPTION_CLASS =
	/^(Config\w+|DestructiveChangesRequired|AdminMutationUnverifiedTransaction|ConcurrencyConflict)Exception$/;

function hasControlCharacter(text: string): boolean {
	return Array.from(text).some((char) => {
		const code = char.charCodeAt(0);
		return code < 0x20 || (code >= 0x7f && code <= 0x9f);
	});
}

async function instantiateConfigExceptions(): Promise<BaseException[]> {
	const exceptions = (await import('../../exceptions/index.js')) as Record<string, unknown>;

	return Object.entries(exceptions)
		.filter(
			([name, exported]) =>
				CONFIG_EXCEPTION_CLASS.test(name) &&
				typeof exported === 'function' &&
				exported.prototype instanceof BaseException
		)
		.map(([, exported]) => new (exported as new (message: string) => BaseException)('message'));
}

function start(overrides: Partial<ConfigRunStart> = {}): ConfigRunStart {
	return {
		source: 'cli',
		caller: systemCaller(),
		dryRun: false,
		destructive: false,
		manifestVersion: 1,
		managedKinds: ['roles'],
		emit: 'always',
		...overrides,
	};
}

function emitted(): ConfigRunRecord[] {
	return vi
		.mocked(logger.info)
		.mock.calls.filter((call) => (call[0] as ConfigRunRecord | undefined)?.event === CONFIG_RUN_EVENT)
		.map((call) => call[0] as ConfigRunRecord);
}

beforeEach(() => {
	delete factoryEnv['LOG_STYLE'];
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('classifyConfigError', () => {
	it('classifies every config exception class with an allowlisted code and the mapped result', async () => {
		const instances = await instantiateConfigExceptions();
		expect(instances.length).toBeGreaterThan(0);

		const seen = new Set<string>();

		for (const instance of instances) {
			const classified = classifyConfigError(instance);

			expect(RUN_RECORD_ERROR_CODES.has(classified.errorCode)).toBe(true);
			expect(classified.errorCode).toBe(instance.code);
			expect(classified.result).toBe(EXPECTED_RESULT[instance.code] ?? 'failed');
			seen.add(instance.code);
		}

		expect(seen).toEqual(new Set(RUN_RECORD_ERROR_CODES));
	});

	it('classifies a uniform array of validation exceptions as invalid with the first code', async () => {
		const { ConfigIdentityConflictException, ConfigInvalidException } = await import('../../exceptions/index.js');

		const classified = classifyConfigError([
			new ConfigIdentityConflictException('first'),
			new ConfigInvalidException('second'),
		]);

		expect(classified).toEqual({ result: 'invalid', errorCode: 'CONFIG_IDENTITY_CONFLICT' });
	});

	it('classifies a BaseException with a novel code as failed and UNEXPECTED', () => {
		const classified = classifyConfigError(new BaseException('message', 500, 'EXTENSION_NOVEL_CODE'));
		expect(classified).toEqual({ result: 'failed', errorCode: UNEXPECTED_ERROR_CODE });
	});

	it('classifies a plain Error, a string, and an empty array as failed and UNEXPECTED', () => {
		for (const thrown of [new Error('boom'), 'boom', []]) {
			expect(classifyConfigError(thrown)).toEqual({ result: 'failed', errorCode: UNEXPECTED_ERROR_CODE });
		}
	});

	it('never carries a hostile code or message into the classification', () => {
		const hostile = new BaseException(`${MARKER}${CONTROL}`, 500, `${MARKER}${CONTROL}`);
		const serialized = JSON.stringify(classifyConfigError(hostile));

		expect(serialized).not.toContain(MARKER);
		expect(hasControlCharacter(serialized)).toBe(false);
	});
});

describe('normalizeErrorCode', () => {
	it('passes every allowlisted code through and maps everything else to UNEXPECTED', () => {
		for (const code of RUN_RECORD_ERROR_CODES) expect(normalizeErrorCode(code)).toBe(code);

		for (const code of ['EXTENSION_NOVEL', `${MARKER}${CONTROL}`, '', 42, null, undefined, {}]) {
			expect(normalizeErrorCode(code)).toBe(UNEXPECTED_ERROR_CODE);
		}
	});
});

describe('callerFromAccountability', () => {
	it('records user and role when both are UUIDs', () => {
		const accountability = { user: USER, role: ROLE, admin: true, app: true } as Accountability;
		expect(callerFromAccountability(accountability)).toEqual({ kind: 'user', user: USER, role: ROLE });
	});

	it.each([
		['a marker', MARKER],
		['control characters', `${USER}${CONTROL}`],
		['a non-UUID', 'not-a-uuid'],
		['an empty string', ''],
	])('falls back to the request caller when the user carries %s', (_label, user) => {
		const accountability = { user, role: ROLE, admin: true, app: true } as Accountability;
		const caller = callerFromAccountability(accountability);

		expect(caller).toEqual({ kind: 'request' });
		expect(JSON.stringify(caller)).not.toContain(MARKER);
	});

	it('falls back to the request caller when the role is not a UUID', () => {
		const accountability = { user: USER, role: `${MARKER}${CONTROL}`, admin: true, app: true } as Accountability;
		expect(callerFromAccountability(accountability)).toEqual({ kind: 'request' });
	});

	it('falls back to the request caller for a null or absent accountability', () => {
		expect(callerFromAccountability(null)).toEqual({ kind: 'request' });
		expect(callerFromAccountability(undefined)).toEqual({ kind: 'request' });
	});

	it('never includes the ip', () => {
		const accountability = { user: USER, role: ROLE, admin: true, app: true, ip: '10.0.0.1' } as Accountability;
		expect(callerFromAccountability(accountability)).not.toHaveProperty('ip');
	});
});

describe('userAgentFrom', () => {
	it('neutralizes control characters and bounds the length', () => {
		const header = `${MARKER}${CONTROL}${'a'.repeat(100)}`;
		const userAgent = userAgentFrom(header)!;

		expect(hasControlCharacter(userAgent)).toBe(false);
		expect(userAgent.length).toBeLessThanOrEqual(64 + '...'.length);
		expect(userAgent.endsWith('...')).toBe(true);
	});

	it('passes an ordinary product token through unchanged', () => {
		expect(userAgentFrom('cairncms-cli/1.6.0')).toBe('cairncms-cli/1.6.0');
	});

	it('yields no value for an absent, empty, or non-string header', () => {
		expect(userAgentFrom(undefined)).toBeUndefined();
		expect(userAgentFrom('')).toBeUndefined();
		expect(userAgentFrom(['a', 'b'])).toBeUndefined();
	});
});

describe('shouldEmit', () => {
	it.each([undefined, 'pretty', 'raw', 'anything'])('is true for the always policy under style %j', (style) => {
		factoryEnv['LOG_STYLE'] = style;
		expect(shouldEmit('always')).toBe(true);
	});

	it('is true for the raw-only policy only under the raw style', () => {
		for (const style of [undefined, 'pretty', 'anything']) {
			factoryEnv['LOG_STYLE'] = style;
			expect(shouldEmit('raw-only')).toBe(false);
		}

		factoryEnv['LOG_STYLE'] = 'raw';
		expect(shouldEmit('raw-only')).toBe(true);
	});
});

describe('emitConfigRunRecord', () => {
	it('swallows a throwing logger', () => {
		vi.mocked(logger.info).mockImplementationOnce(() => {
			throw new Error('sink down');
		});

		const record: ConfigRunRecord = {
			event: CONFIG_RUN_EVENT,
			source: 'cli',
			caller: systemCaller(),
			dryRun: true,
			destructive: false,
			manifestVersion: 1,
			managedKinds: ['roles'],
			result: 'planned',
			durationMs: 0,
		};

		expect(() => emitConfigRunRecord(record)).not.toThrow();
	});

	it('logs the record at info with the fixed message', () => {
		const record: ConfigRunRecord = {
			event: CONFIG_RUN_EVENT,
			source: 'http',
			caller: { kind: 'request' },
			dryRun: false,
			destructive: false,
			manifestVersion: 1,
			managedKinds: [],
			result: 'no_changes',
			durationMs: 3,
		};

		emitConfigRunRecord(record);

		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledWith(record, CONFIG_RUN_MESSAGE);
	});
});

describe('withConfigRun', () => {
	it('emits exactly one record on return with the returned result and no error code', async () => {
		const finished = await withConfigRun(start({ dryRun: true }), async () => ({ result: 'planned' as const }));

		expect(finished).toEqual({ result: 'planned' });
		expect(emitted()).toHaveLength(1);

		const record = emitted()[0]!;
		expect(record).toMatchObject({ event: CONFIG_RUN_EVENT, source: 'cli', dryRun: true, result: 'planned' });
		expect(record).not.toHaveProperty('errorCode');
		expect(record).not.toHaveProperty('changes');
		expect(record).not.toHaveProperty('runId');
		expect(record).not.toHaveProperty('userAgent');
		expect(Number.isInteger(record.durationMs)).toBe(true);
		expect(record.durationMs).toBeGreaterThanOrEqual(0);
	});

	it.each(['no_changes', 'planned', 'discarded', 'applied'] as const)(
		'omits errorCode for the %s result',
		async (result) => {
			await withConfigRun(start(), async () => ({ result }));
			expect(emitted()[0]).not.toHaveProperty('errorCode');
		}
	);

	it('carries the error code a body reports for a refusal it produced itself', async () => {
		await withConfigRun(start(), async () => ({ result: 'refused' as const, errorCode: 'CONFIG_PROTECTED_RECORD' }));
		expect(emitted()[0]).toMatchObject({ result: 'refused', errorCode: 'CONFIG_PROTECTED_RECORD' });
	});

	it('normalizes a body-returned error code outside the allowlist to UNEXPECTED', async () => {
		const hostile = `${MARKER}${CONTROL}` as never;

		await withConfigRun(start(), async () => ({ result: 'failed' as const, errorCode: hostile }));

		const serialized = JSON.stringify(emitted()[0]);
		expect(emitted()[0]).toMatchObject({ result: 'failed', errorCode: UNEXPECTED_ERROR_CODE });
		expect(serialized).not.toContain(MARKER);
		expect(hasControlCharacter(serialized)).toBe(false);
	});

	it('records the change counts once planned was called', async () => {
		await withConfigRun(start(), async (run) => {
			run.planned({ create: 1, update: 2, delete: 3 });
			return { result: 'applied' as const };
		});

		expect(emitted()[0]).toMatchObject({ changes: { create: 1, update: 2, delete: 3 } });
	});

	describe('normalizes a hostile start at the sink', () => {
		it.each([
			['a non-UUID', 'run-123'],
			['control characters', `${USER}${CONTROL}`],
			['a marker', MARKER],
		])('drops a run id carrying %s', async (_label, runId) => {
			await withConfigRun(start({ runId }), async () => ({ result: 'applied' as const }));

			expect(emitted()[0]).not.toHaveProperty('runId');
			expect(JSON.stringify(emitted()[0])).not.toContain(MARKER);
		});

		it('replaces a user caller whose ids are not UUIDs with the request caller', async () => {
			const caller = { kind: 'user', user: `${MARKER}${CONTROL}`, role: ROLE } as never;

			await withConfigRun(start({ caller }), async () => ({ result: 'applied' as const }));

			expect(emitted()[0]!.caller).toEqual({ kind: 'request' });
		});

		it('demotes a system caller with a foreign origin to the request caller', async () => {
			for (const origin of [`${MARKER}${CONTROL}`, 'config-cli ', '', undefined] as never[]) {
				vi.mocked(logger.info).mockClear();

				await withConfigRun(start({ caller: { kind: 'system', origin } as never }), async () => ({
					result: 'applied' as const,
				}));

				expect(emitted()[0]!.caller).toEqual({ kind: 'request' });
			}
		});

		it('keeps the genuine system caller', async () => {
			await withConfigRun(start({ caller: systemCaller() }), async () => ({ result: 'applied' as const }));

			expect(emitted()[0]!.caller).toEqual({ kind: 'system', origin: 'config-cli' });
		});

		it('replaces a caller of unknown shape with the request caller', async () => {
			for (const caller of [null, 'admin', { kind: MARKER }, { kind: 'user', user: USER }] as never[]) {
				vi.mocked(logger.info).mockClear();
				await withConfigRun(start({ caller }), async () => ({ result: 'applied' as const }));
				expect(emitted()[0]!.caller).toEqual({ kind: 'request' });
			}
		});

		it('neutralizes and bounds an unsanitized user agent', async () => {
			await withConfigRun(start({ userAgent: `${MARKER}${CONTROL}${'a'.repeat(100)}` }), async () => ({
				result: 'applied' as const,
			}));

			const userAgent = emitted()[0]!.userAgent!;
			expect(hasControlCharacter(userAgent)).toBe(false);
			expect(userAgent.length).toBeLessThanOrEqual(64 + '...'.length);
		});

		it('keeps only known managed kinds', async () => {
			await withConfigRun(start({ managedKinds: ['roles', MARKER, 42] as never }), async () => ({
				result: 'applied' as const,
			}));

			expect(emitted()[0]!.managedKinds).toEqual(['roles']);
		});
	});

	it('classifies a thrown error, emits exactly once, and rethrows the same error', async () => {
		const { ConfigStateChangedException } = await import('../../exceptions/index.js');
		const thrown = new ConfigStateChangedException();

		await expect(
			withConfigRun(start(), async () => {
				throw thrown;
			})
		).rejects.toBe(thrown);

		expect(emitted()).toHaveLength(1);
		expect(emitted()[0]).toMatchObject({ result: 'state_changed', errorCode: 'CONFIG_STATE_CHANGED' });
	});

	it('records a hostile thrown error as failed and UNEXPECTED without its marker or control characters', async () => {
		const thrown = new BaseException(`${MARKER}${CONTROL}`, 500, `${MARKER}${CONTROL}`);

		await withConfigRun(start(), async () => {
			throw thrown;
		}).catch(() => undefined);

		const serialized = JSON.stringify(emitted()[0]);
		expect(emitted()[0]).toMatchObject({ result: 'failed', errorCode: UNEXPECTED_ERROR_CODE });
		expect(serialized).not.toContain(MARKER);
		expect(hasControlCharacter(serialized)).toBe(false);
	});

	it('carries runId and userAgent when the start supplies them', async () => {
		const runId = '9b2c1b0e-3f6c-4a1d-8f2e-0a7d5c4b3e21';

		await withConfigRun(
			start({ source: 'http', caller: { kind: 'request' }, runId, userAgent: 'cairncms-cli/1.6.0' }),
			async () => ({ result: 'no_changes' as const })
		);

		expect(emitted()[0]).toMatchObject({ runId, userAgent: 'cairncms-cli/1.6.0', source: 'http' });
	});

	it('emits nothing under the raw-only policy unless the style is raw', async () => {
		await withConfigRun(start({ emit: 'raw-only' }), async () => ({ result: 'applied' as const }));
		expect(emitted()).toHaveLength(0);

		factoryEnv['LOG_STYLE'] = 'raw';
		await withConfigRun(start({ emit: 'raw-only' }), async () => ({ result: 'applied' as const }));
		expect(emitted()).toHaveLength(1);
	});

	it('returns the body result unchanged when the logger throws', async () => {
		vi.mocked(logger.info).mockImplementation(() => {
			throw new Error('sink down');
		});

		const finished = await withConfigRun(start(), async () => ({ result: 'applied' as const }));
		expect(finished).toEqual({ result: 'applied' });
	});

	it('copies the managed kinds rather than sharing the caller array', async () => {
		const managedKinds: ConfigKind[] = ['roles'];
		await withConfigRun(start({ managedKinds }), async () => ({ result: 'applied' as const }));

		managedKinds.push('permissions');
		expect(emitted()[0]!.managedKinds).toEqual(['roles']);
	});
});
