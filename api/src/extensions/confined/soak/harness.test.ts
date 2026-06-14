import { describe, expect, it } from 'vitest';
import { assertSoakClean, runSoak } from './harness.js';

describe('confined runtime soak smoke', () => {
	it('drives confined invocations across exit paths with no slot or cgroup leak', async () => {
		const result = await runSoak({ count: 40 });

		assertSoakClean(result);

		// Every exit path was both planned and observed producing its intended outcome.
		expect(result.mismatches).toBe(0);
		expect(result.observedPaths.complete).toBeGreaterThan(0);
		expect(result.observedPaths.crash).toBeGreaterThan(0);
		expect(result.observedPaths.timeout).toBeGreaterThan(0);
		expect(result.observedPaths.oversize).toBeGreaterThan(0);

		// Every invocation runs its full cgroup lifecycle, so created tracks the total and
		// every created handle is placed once and removed once with no stray operation.
		expect(result.cgroup.created).toBe(40);
		expect(result.cgroup.unexpectedOps).toBe(0);
		expect(result.cgroup.placedExactlyOnce).toBe(40);
		expect(result.cgroup.removedExactlyOnce).toBe(40);
		expect(result.cgroup.pending).toBe(0);
		expect(result.liveness).toEqual({ active: 0, queued: 0 });
	}, 60_000);
});
