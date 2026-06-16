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

// One declared server entry of a confined bundle, for the all-entries bundle probe.
// `key` is the `type:name` key the entry is exposed under in the CairnBundle record,
// and `name` is the config id the entry must carry. A hook entry must carry the
// manifest events its declared handler sets are required to equal, so a hook with no
// subscription cannot load inert.
export type ConfinedBundleProbeEntry =
	| { key: string; name: string; kind: 'operation' | 'endpoint' }
	| { key: string; name: string; kind: 'hook'; events: { filters: string[]; actions: string[] } };

export interface ConfinedInvocation {
	extensionId: string;
	contributionId: string;
	// The invocation owner carried into every host-call context: the flow operation
	// row id for an operation, the contribution id for an endpoint.
	operationId: string;
	// Selects the guest contract the engine builds. Absent means flow-operation.
	activation?: 'flow-operation' | 'json-endpoint' | 'event-filter' | 'event-action';
	// When set, the run path selects this entry from the bundle artifact's CairnBundle
	// record instead of the top-level contract global.
	bundleEntryKey?: string;
	// When set, the probe path validates every declared entry against the one bundle
	// artifact rather than a single top-level config.
	bundleEntries?: ConfinedBundleProbeEntry[];
	// The built server entry the engine evaluates.
	entrySource: string;
	options: Record<string, unknown>;
	// The flow `$last` for an operation, the shaped JSON request for an endpoint.
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

export interface ConfinedJobMessage {
	type: 'job';
	invocation: ConfinedInvocation;
}

export interface ConfinedDoneMessage {
	type: 'done';
	result: ConfinedResult;
}

// The load verdict: the entry evaluated and exposed a valid confined config, or
// the reason it cannot be loaded. The probe never invokes the handler.
export type ConfinedLoadProbeResult = { loadable: true } | { loadable: false; error: ConfinedRuntimeError };

// A distinct job kind, not a flag on the run job, so the parent-to-child contract
// never blends running a handler with probing loadability.
export interface ConfinedProbeJobMessage {
	type: 'probe';
	invocation: ConfinedInvocation;
}

export interface ConfinedProbeDoneMessage {
	type: 'probe-done';
	result: ConfinedLoadProbeResult;
}

export interface ConfinedHostCall {
	method: string;
	args: unknown;
}

// Host failures travel as data (`ok: false`), never as thrown exceptions, so the
// guest receives a denial as a value.
export type ConfinedHostReply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

export interface ConfinedHostCallContext {
	extensionId: string;
	contributionId: string;
	operationId: string;
}

// Child-side: forwards a guest host call to the parent.
export type ConfinedHostBridge = (call: ConfinedHostCall) => Promise<ConfinedHostReply>;

// Parent-side: serves a host call. The signal aborts at the per-call timeout, and a
// long-running operation must honor it or abandoned work leaks.
export type ConfinedHostDispatcher = (
	call: ConfinedHostCall,
	context: ConfinedHostCallContext,
	signal: AbortSignal
) => Promise<ConfinedHostReply>;

export interface ConfinedHostCallMessage {
	type: 'host-call';
	id: number;
	method: string;
	args: unknown;
}

export interface ConfinedHostReplyMessage {
	type: 'host-reply';
	id: number;
	reply: ConfinedHostReply;
}
