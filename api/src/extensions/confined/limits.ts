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

export const DEFAULT_MAX_CONCURRENT_CONFINED_HOSTS = 4;
