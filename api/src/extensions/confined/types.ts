/**
 * Internal confined-runtime contract. Not part of the public author API, and no
 * QuickJS type is exposed: results are serializable, so a child crash or timeout
 * surfaces as an operation failure rather than an API-process crash.
 */

export interface ConfinedRuntimeLimits {
	// Parent-enforced hard wall-clock kill. The mandatory backstop for memory and hangs.
	wallClockMs: number;
	// In-engine CPU timeout. Bounds CPU loops and idle async awaits.
	cpuTimeoutMs: number;
	// In-engine memory limit in bytes.
	memoryBytes: number;
	// In-engine stack limit in bytes.
	stackBytes: number;
	// How long to wait for a free child-host slot before failing closed with `busy`. 0 rejects immediately.
	acquireTimeoutMs: number;
	// Per-call timeout for a brokered host call. A hanging dispatcher resolves to a timeout reply.
	hostCallTimeoutMs: number;
	// Maximum total host calls one invocation may make before further calls are rate-limited.
	maxHostCalls: number;
	// Maximum concurrent in-flight host calls before further calls are rate-limited.
	maxInFlightHostCalls: number;
}

export interface ConfinedAccountability {
	user: string | null;
	role: string | null;
	admin: boolean;
}

export interface ConfinedInvocation {
	extensionId: string;
	contributionId: string;
	operationId: string;
	// The built server entry the engine evaluates.
	entrySource: string;
	options: Record<string, unknown>;
	input: unknown;
	accountability: ConfinedAccountability | null;
	limits: ConfinedRuntimeLimits;
}

export type ConfinedRuntimeErrorCode =
	| 'timeout'
	| 'crash'
	| 'invalid-entry'
	| 'identity-mismatch'
	| 'guest-error'
	| 'invalid-result'
	| 'busy'
	| 'internal';

export interface ConfinedRuntimeError {
	code: ConfinedRuntimeErrorCode;
	message: string;
}

export type ConfinedResult = { ok: true; value: unknown } | { ok: false; error: ConfinedRuntimeError };
