import { describe, expect, it } from 'vitest';
import { assertSoakClean, runSoak } from './harness.js';

describe('confined runtime soak smoke', () => {
	it('drives confined invocations across exit paths with no slot or cgroup leak', async () => {
		const result = await runSoak({ count: 42 });

		assertSoakClean(result);

		// Every exit path was both planned and observed producing its intended outcome.
		expect(result.mismatches).toBe(0);
		expect(result.observedPaths.complete).toBeGreaterThan(0);
		expect(result.observedPaths.crash).toBeGreaterThan(0);
		expect(result.observedPaths.timeout).toBeGreaterThan(0);
		expect(result.observedPaths.oversize).toBeGreaterThan(0);
		expect(result.observedPaths['hostcall-timeout']).toBeGreaterThan(0);
		expect(result.observedPaths['hostcall-flood']).toBeGreaterThan(0);

		// The host-call lifecycle fired every gate: the per-call timer, the in-flight cap, and
		// the total cap. The saturation pass drove both the busy and the queue paths above the
		// process cap.
		expect(result.hostCall.dispatched).toBeGreaterThan(0);
		expect(result.hostCall.timeouts).toBeGreaterThan(0);
		expect(result.hostCall.inFlightDenials).toBeGreaterThan(0);
		expect(result.hostCall.totalDenials).toBeGreaterThan(0);
		expect(result.saturation.busy).toBeGreaterThan(0);
		expect(result.saturation.queueBusy).toBe(0);
		expect(result.saturation.queueRan).toBeGreaterThan(result.saturation.maxConcurrent);

		// Every spawned child is reaped, and every cgroup it created is placed once and
		// removed once with no stray operation. The cgroup-equals-children tie is enforced by
		// assertSoakClean above.
		expect(result.orphanedPids).toBe(0);
		expect(result.cgroup.unexpectedOps).toBe(0);
		expect(result.cgroup.placedExactlyOnce).toBe(result.cgroup.created);
		expect(result.cgroup.removedExactlyOnce).toBe(result.cgroup.created);
		expect(result.cgroup.pending).toBe(0);
		expect(result.liveness).toEqual({ active: 0, queued: 0 });
	}, 60_000);
});
