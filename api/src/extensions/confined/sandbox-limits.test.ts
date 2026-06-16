import { describe, expect, it } from 'vitest';
import {
	BROKER_REPLY_BYTES,
	HTTP_RESPONSE_BYTES,
	ITEMS_REPLY_BYTES,
	OVER_CAP_HOST_REPLY,
	REPLY_ENVELOPE_BYTES,
	resolveSandboxConfig,
	resolveSandboxLimits,
	SETTINGS_VALUE_BYTES,
	TEMPLATE_OUTPUT_BYTES,
	type SandboxConfigDeps,
} from './sandbox-limits.js';

const KiB = 1024;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// A generous effective memory so the guest-memory budget never gates the transport/frame
// tests, which exercise the parent frame-budget check instead.
const ROOMY: SandboxConfigDeps = { effectiveMemory: () => 64 * GiB };

function resolve(env: Record<string, unknown> = {}, deps: SandboxConfigDeps = ROOMY) {
	return resolveSandboxLimits(env, deps);
}

describe('resolveSandboxLimits', () => {
	it('resolves conservative defaults when nothing is set', () => {
		const result = resolve({});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.limits.maxResultBytes).toBe(1 * MiB);
			expect(result.limits.maxHostApiCallBytes).toBe(256 * KiB);
			expect(result.limits.maxArtifactBytes).toBe(8 * MiB);
			expect(result.limits.maxProcesses).toBe(4);
		}
	});

	it('parses a human-readable cap and a bare byte integer alike', () => {
		expect(
			resolve({ EXTENSIONS_SANDBOX_MAX_RESULT: '2mb' }).ok && resolve({ EXTENSIONS_SANDBOX_MAX_RESULT: '2mb' })
		).toMatchObject({
			limits: { maxResultBytes: 2 * MiB },
		});

		const bare = resolve({ EXTENSIONS_SANDBOX_MAX_RESULT: String(2 * MiB) });
		if (bare.ok) expect(bare.limits.maxResultBytes).toBe(2 * MiB);
	});

	it('derives the directional frame budgets from the caps', () => {
		const result = resolve({
			EXTENSIONS_SANDBOX_MAX_RESULT: '2mb',
			EXTENSIONS_SANDBOX_MAX_HOST_API_CALL: '512kb',
			EXTENSIONS_SANDBOX_MAX_ARTIFACT: '4mb',
		});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.limits.childToParentFrameMax).toBe(2 * MiB + 4 * KiB);
			expect(result.limits.parentToChildFrameMax).toBe(4 * MiB + 256 * KiB + 4 * KiB);
		}
	});

	it('rejects a malformed value, naming the env var', () => {
		const result = resolve({ EXTENSIONS_SANDBOX_MAX_RESULT: '1gib' });

		expect(result.ok).toBe(false);

		if (!result.ok) {
			expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_MAX_RESULT');
			expect(result.error.message).toContain('must be a size like "16mb"');
		}
	});

	it('rejects a below-floor and an above-ceiling value', () => {
		expect(resolve({ EXTENSIONS_SANDBOX_MAX_RESULT: '8' }).ok).toBe(false);
		expect(resolve({ EXTENSIONS_SANDBOX_MAX_RESULT: '64mb' }).ok).toBe(false);
	});

	it('fails an unsafe combination of payloads and concurrency on the frame budget', () => {
		const result = resolve({
			EXTENSIONS_SANDBOX_MAX_RESULT: '16mb',
			EXTENSIONS_SANDBOX_MAX_ARTIFACT: '32mb',
			EXTENSIONS_SANDBOX_MAX_PROCESSES: '32',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_MAX_PROCESSES');
	});

	it('lets a high payload pass when concurrency is lowered', () => {
		expect(
			resolve({
				EXTENSIONS_SANDBOX_MAX_RESULT: '16mb',
				EXTENSIONS_SANDBOX_MAX_ARTIFACT: '32mb',
				EXTENSIONS_SANDBOX_MAX_PROCESSES: '4',
			}).ok
		).toBe(true);
	});

	it('returns errors as values rather than throwing', () => {
		expect(() => resolveSandboxLimits({ EXTENSIONS_SANDBOX_MAX_PROCESSES: 'bad' })).not.toThrow();
		expect(resolve({ EXTENSIONS_SANDBOX_MAX_PROCESSES: 'bad' }).ok).toBe(false);
	});
});

describe('resolveSandboxConfig: memory and timeout', () => {
	it('resolves the guest memory and wall-clock into the runtime limits', () => {
		const result = resolveSandboxConfig(
			{ EXTENSIONS_SANDBOX_MAX_MEMORY: '128mb', EXTENSIONS_SANDBOX_TIMEOUT: '30s' },
			ROOMY
		);

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.config.runtime.memoryBytes).toBe(128 * MiB);
			expect(result.config.runtime.wallClockMs).toBe(30_000);
		}
	});

	it('clamps the CPU timeout strictly below a low wall-clock', () => {
		const low = resolveSandboxConfig({ EXTENSIONS_SANDBOX_TIMEOUT: '1s' }, ROOMY);
		if (low.ok) expect(low.config.runtime.cpuTimeoutMs).toBe(800);

		const high = resolveSandboxConfig({ EXTENSIONS_SANDBOX_TIMEOUT: '30s' }, ROOMY);
		if (high.ok) expect(high.config.runtime.cpuTimeoutMs).toBe(2_000);
	});

	it('rejects out-of-range and malformed memory', () => {
		expect(resolveSandboxConfig({ EXTENSIONS_SANDBOX_MAX_MEMORY: '8mb' }, ROOMY).ok).toBe(false);
		expect(resolveSandboxConfig({ EXTENSIONS_SANDBOX_MAX_MEMORY: '1gb' }, ROOMY).ok).toBe(false);
		expect(resolveSandboxConfig({ EXTENSIONS_SANDBOX_MAX_MEMORY: '1gib' }, ROOMY).ok).toBe(false);
	});
});

describe('resolveSandboxConfig: adaptive and explicit concurrency', () => {
	const processesAt = (effectiveMemory: number, env: Record<string, unknown> = {}) =>
		resolveSandboxConfig(env, { effectiveMemory: () => effectiveMemory });

	it('adapts the unset default to the memory budget', () => {
		// perChild at the 64mb default is about 223mb, the budget is half the effective memory.
		for (const [memory, expected] of [
			[256 * MiB, 1],
			[512 * MiB, 1],
			[1 * GiB, 2],
			[4 * GiB, 4],
			[64 * GiB, 4],
		] as const) {
			const result = processesAt(memory);
			expect(result.ok && result.config.sandbox.maxProcesses).toBe(expected);
		}
	});

	it('fails closed when explicit concurrency overcommits the guest-memory budget', () => {
		const result = processesAt(1 * GiB, { EXTENSIONS_SANDBOX_MAX_PROCESSES: '4' });

		expect(result.ok).toBe(false);

		if (!result.ok) {
			expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_MAX_PROCESSES');
			expect(result.error.message).toContain('EXTENSIONS_SANDBOX_MAX_MEMORY');
		}
	});

	it('accepts explicit concurrency that fits the budget', () => {
		const result = processesAt(4 * GiB, { EXTENSIONS_SANDBOX_MAX_PROCESSES: '4' });
		expect(result.ok && result.config.sandbox.maxProcesses).toBe(4);
	});

	it('allows 1 as the runnable baseline however specified, even below the share', () => {
		// 256mb gives a 128mb budget, below the about 223mb per-child cost, yet 1 still runs.
		const tiny = 256 * MiB;
		const unset = processesAt(tiny);
		expect(unset.ok && unset.config.sandbox.maxProcesses).toBe(1);
		expect(processesAt(tiny, { EXTENSIONS_SANDBOX_MAX_PROCESSES: '1' }).ok).toBe(true);
		expect(processesAt(tiny, { EXTENSIONS_SANDBOX_MAX_PROCESSES: '2' }).ok).toBe(false);
	});

	it('fails closed when one child cannot fit the effective memory', () => {
		// 128mb effective, but one child at the 64mb default needs about 223mb.
		const result = processesAt(128 * MiB);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_MAX_MEMORY');
	});

	it('rejects an invalid effective-memory reading', () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(resolveSandboxConfig({}, { effectiveMemory: () => bad }).ok).toBe(false);
		}
	});
});

describe('the broker reply caps and the frame budget', () => {
	it('resolves the broker caps as limits', () => {
		const result = resolve({});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.limits.brokerReplyBytes).toBe(BROKER_REPLY_BYTES);
			expect(result.limits.httpResponseBytes).toBe(HTTP_RESPONSE_BYTES);
			expect(result.limits.itemsReplyBytes).toBe(ITEMS_REPLY_BYTES);
			expect(result.limits.templateOutputBytes).toBe(TEMPLATE_OUTPUT_BYTES);
			expect(result.limits.settingsValueBytes).toBe(SETTINGS_VALUE_BYTES);
		}
	});

	it('keeps every per-surface cap plus the reply envelope under the reply cap', () => {
		for (const cap of [HTTP_RESPONSE_BYTES, ITEMS_REPLY_BYTES, TEMPLATE_OUTPUT_BYTES, SETTINGS_VALUE_BYTES]) {
			expect(cap + REPLY_ENVELOPE_BYTES).toBeLessThanOrEqual(BROKER_REPLY_BYTES);
		}
	});

	it('fits a serialized reply frame at any surface cap under the chokepoint cap', () => {
		// The surface caps bound the serialized reply value, so the worst frame at a
		// surface cap is the value plus the host-reply wrapper.
		for (const cap of [HTTP_RESPONSE_BYTES, ITEMS_REPLY_BYTES, TEMPLATE_OUTPUT_BYTES, SETTINGS_VALUE_BYTES]) {
			const wrapper = JSON.stringify({
				type: 'host-reply',
				id: Number.MAX_SAFE_INTEGER,
				reply: { ok: true, value: '' },
			});

			expect(cap + Buffer.byteLength(wrapper, 'utf8')).toBeLessThanOrEqual(BROKER_REPLY_BYTES);
		}
	});

	it('keeps the canonical over-cap fallback under the reply cap', () => {
		const fallback = JSON.stringify({ type: 'host-reply', id: Number.MAX_SAFE_INTEGER, reply: OVER_CAP_HOST_REPLY });
		expect(Buffer.byteLength(fallback, 'utf8')).toBeLessThanOrEqual(BROKER_REPLY_BYTES);
	});

	it('budgets the parent-to-child frame for the reply cap when the artifact budget is smaller', () => {
		const result = resolve({ EXTENSIONS_SANDBOX_MAX_ARTIFACT: '1kb' });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.limits.parentToChildFrameMax).toBe(BROKER_REPLY_BYTES + 4 * KiB);
	});

	it('fits every broker reply under the child frame reader', () => {
		const result = resolve({ EXTENSIONS_SANDBOX_MAX_ARTIFACT: '1kb' });

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(BROKER_REPLY_BYTES).toBeLessThanOrEqual(result.limits.parentToChildFrameMax);
		}
	});
});
