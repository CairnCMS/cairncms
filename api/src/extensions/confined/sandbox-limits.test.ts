import { describe, expect, it } from 'vitest';
import { resolveSandboxLimits } from './sandbox-limits.js';

const KiB = 1024;
const MiB = 1024 * 1024;

function resolve(env: Record<string, string | undefined> = {}) {
	return resolveSandboxLimits(env);
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

	it('parses an explicit cap', () => {
		const result = resolve({ EXTENSIONS_SANDBOX_MAX_RESULT_BYTES: String(2 * MiB) });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.limits.maxResultBytes).toBe(2 * MiB);
	});

	it('derives the directional frame budgets from the caps', () => {
		const result = resolve({
			EXTENSIONS_SANDBOX_MAX_RESULT_BYTES: String(2 * MiB),
			EXTENSIONS_SANDBOX_MAX_HOST_API_CALL_BYTES: String(512 * KiB),
			EXTENSIONS_SANDBOX_MAX_ARTIFACT_BYTES: String(4 * MiB),
		});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.limits.childToParentFrameMax).toBe(2 * MiB + 4 * KiB);
			expect(result.limits.parentToChildFrameMax).toBe(4 * MiB + 256 * KiB + 4 * KiB);
		}
	});

	it('rejects a malformed value, naming the env var', () => {
		const result = resolve({ EXTENSIONS_SANDBOX_MAX_RESULT_BYTES: 'not-a-number' });

		expect(result.ok).toBe(false);

		if (!result.ok) {
			expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_MAX_RESULT_BYTES');
			expect(result.error.message).toContain('EXTENSIONS_SANDBOX_MAX_RESULT_BYTES');
		}
	});

	it('rejects a below-floor value (the unit-confusion case)', () => {
		// 8 bytes reads like an operator who typed a KB-scale number into a bytes field.
		const result = resolve({ EXTENSIONS_SANDBOX_MAX_RESULT_BYTES: '8' });

		expect(result.ok).toBe(false);

		if (!result.ok) {
			expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_MAX_RESULT_BYTES');
			expect(result.error.message).toMatch(/at least/);
		}
	});

	it('rejects an above-ceiling value', () => {
		const result = resolve({ EXTENSIONS_SANDBOX_MAX_RESULT_BYTES: String(64 * MiB) });

		expect(result.ok).toBe(false);

		if (!result.ok) {
			expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_MAX_RESULT_BYTES');
			expect(result.error.message).toMatch(/at most/);
		}
	});

	it('fails an unsafe combination of payloads and concurrency', () => {
		const result = resolve({
			EXTENSIONS_SANDBOX_MAX_RESULT_BYTES: String(16 * MiB),
			EXTENSIONS_SANDBOX_MAX_ARTIFACT_BYTES: String(32 * MiB),
			EXTENSIONS_SANDBOX_MAX_PROCESSES: '32',
		});

		expect(result.ok).toBe(false);

		if (!result.ok) {
			expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_MAX_PROCESSES');
			expect(result.error.message).toMatch(/budget/);
		}
	});

	it('fails on the child-to-parent direction even with a small artifact', () => {
		// The consistency check must include the child-to-parent budget, the DoS-sensitive
		// direction, not only parent-to-child.
		const result = resolve({
			EXTENSIONS_SANDBOX_MAX_RESULT_BYTES: String(16 * MiB),
			EXTENSIONS_SANDBOX_MAX_HOST_API_CALL_BYTES: String(4 * MiB),
			EXTENSIONS_SANDBOX_MAX_ARTIFACT_BYTES: String(1 * MiB),
			EXTENSIONS_SANDBOX_MAX_PROCESSES: '32',
		});

		expect(result.ok).toBe(false);
	});

	it('lets a high payload pass when concurrency is lowered', () => {
		const result = resolve({
			EXTENSIONS_SANDBOX_MAX_RESULT_BYTES: String(16 * MiB),
			EXTENSIONS_SANDBOX_MAX_ARTIFACT_BYTES: String(32 * MiB),
			EXTENSIONS_SANDBOX_MAX_PROCESSES: '4',
		});

		expect(result.ok).toBe(true);
	});

	it('returns errors as values rather than throwing', () => {
		expect(() => resolveSandboxLimits({ EXTENSIONS_SANDBOX_MAX_PROCESSES: 'bad' })).not.toThrow();
		expect(resolve({ EXTENSIONS_SANDBOX_MAX_PROCESSES: 'bad' }).ok).toBe(false);
	});
});
