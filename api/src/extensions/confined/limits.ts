import type { ConfinedRuntimeLimits } from './types.js';

/**
 * Conservative internal defaults. The wall-clock kill must exceed the CPU timeout,
 * so a CPU loop trips the in-engine bound first while the parent kill backstops
 * allocation pressure and idle hangs.
 */

export const DEFAULT_CONFINED_LIMITS: ConfinedRuntimeLimits = {
	wallClockMs: 10_000,
	cpuTimeoutMs: 2_000,
	memoryBytes: 64 * 1024 * 1024,
	stackBytes: 512 * 1024,
	acquireTimeoutMs: 0,
	hostCallTimeoutMs: 5_000,
	maxHostCalls: 1_000,
	maxInFlightHostCalls: 16,
};

export const DEFAULT_SANDBOX_MAX_PROCESSES = 4;

// The cap must cover the child's base RSS (node, the WASM, the bundle), not the guest heap
// alone, or the child is OS-killed before the engine loads. The in-engine `memoryBytes`
// stays the guest fence, the cgroup is the OS backstop.
export const CHILD_BASE_RSS_BYTES = 95 * 1024 * 1024;
export const CGROUP_HEADROOM_BYTES = 64 * 1024 * 1024;

/** The whole-process memory budget for one confined child: base RSS plus the guest heap plus headroom. */
export function cgroupMemoryMax(guestHeapBytes: number): number {
	return CHILD_BASE_RSS_BYTES + guestHeapBytes + CGROUP_HEADROOM_BYTES;
}
