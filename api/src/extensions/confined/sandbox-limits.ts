/** Operator sandbox config: the `EXTENSIONS_SANDBOX_*` knobs, their bounds, the derived
 * transport frame budgets, and the per-invocation runtime limits. One resolver is the source
 * of truth, so the guest-memory budget weighs the memory cap and the process count together
 * and never parses a var twice. */

import { format as formatBytes } from 'bytes';
import { detectEffectiveMemory } from './effective-memory.js';
import { cgroupMemoryMax, DEFAULT_CONFINED_LIMITS, DEFAULT_SANDBOX_MAX_PROCESSES } from './limits.js';
import {
	isUnset,
	parseCount,
	parseDuration,
	parseSize,
	type BoundedSpec,
	type ConfigParseError,
} from './parse-config.js';
import type { ConfinedRuntimeLimits } from './types.js';

const KiB = 1024;
const MiB = 1024 * 1024;

// Per-frame JSON wrapper overhead beyond the payload (message type, id, envelope keys).
const ENVELOPE_BUDGET = 4 * KiB;

// The per-invocation job carries the operation options, input, accountability, and limits
// alongside the built artifact. This budgets that envelope.
const INVOCATION_ENVELOPE = 256 * KiB;

// The parent's worst-case buffered transient must stay under this platform budget.
const PARENT_MEMORY_BUDGET = 256 * MiB;

// The fraction of effective memory the confined sandbox may claim across concurrent
// children, leaving the rest for the API process and the host.
const SANDBOX_MEMORY_SHARE = 0.5;

const RESULT_CAP: BoundedSpec = {
	envVar: 'EXTENSIONS_SANDBOX_MAX_RESULT',
	defaultValue: 1 * MiB,
	floor: 1 * KiB,
	ceiling: 16 * MiB,
};

const HOST_API_CALL_CAP: BoundedSpec = {
	envVar: 'EXTENSIONS_SANDBOX_MAX_HOST_API_CALL',
	defaultValue: 256 * KiB,
	floor: 1 * KiB,
	ceiling: 4 * MiB,
};

const ARTIFACT_CAP: BoundedSpec = {
	envVar: 'EXTENSIONS_SANDBOX_MAX_ARTIFACT',
	defaultValue: 8 * MiB,
	floor: 1 * KiB,
	ceiling: 32 * MiB,
};

const MEMORY_CAP: BoundedSpec = {
	envVar: 'EXTENSIONS_SANDBOX_MAX_MEMORY',
	defaultValue: DEFAULT_CONFINED_LIMITS.memoryBytes,
	floor: 16 * MiB,
	ceiling: 512 * MiB,
};

const TIMEOUT_CAP: BoundedSpec = {
	envVar: 'EXTENSIONS_SANDBOX_TIMEOUT',
	defaultValue: DEFAULT_CONFINED_LIMITS.wallClockMs,
	floor: 1_000,
	ceiling: 300_000,
};

const PROCESSES_CAP: BoundedSpec = {
	envVar: 'EXTENSIONS_SANDBOX_MAX_PROCESSES',
	defaultValue: DEFAULT_SANDBOX_MAX_PROCESSES,
	floor: 1,
	ceiling: 32,
};

// The broker reply caps, internal defaults rather than operator knobs. The reply
// cap bounds every serialized host-reply frame at the supervisor chokepoint, and
// the parent-to-child frame budget derives from it, so a legitimate reply can
// never be a frame the child reader must reject. Each per-surface cap is a bound
// on the SERIALIZED reply value its surface produces, measured by the surface
// before it replies, so passing a surface guarantees passing the chokepoint. The
// surfaces also bound their raw work early (the stream read, the query clamps,
// the render output) as derived controls.
export const BROKER_REPLY_BYTES = 4 * MiB;
export const HTTP_RESPONSE_BYTES = 2 * MiB;
export const ITEMS_REPLY_BYTES = 2 * MiB;
export const TEMPLATE_OUTPUT_BYTES = 1 * MiB;
export const SETTINGS_VALUE_BYTES = 64 * KiB;

// The host-reply frame wrapper around the serialized reply value (type, id, and
// the reply object keys), budgeted generously.
export const REPLY_ENVELOPE_BYTES = 1 * KiB;

// The canonical reply that replaces an over-cap host reply at the chokepoint. It
// must itself fit under the reply cap, asserted at resolution, so the fallback
// can never recurse into its own rejection.
export const OVER_CAP_HOST_REPLY = {
	ok: false,
	error: { code: 'invalid_request', message: 'the host reply exceeded the reply size cap' },
} as const;

export interface SandboxLimits {
	maxResultBytes: number;
	maxHostApiCallBytes: number;
	maxArtifactBytes: number;
	maxProcesses: number;
	childToParentFrameMax: number;
	parentToChildFrameMax: number;
	brokerReplyBytes: number;
	httpResponseBytes: number;
	itemsReplyBytes: number;
	templateOutputBytes: number;
	settingsValueBytes: number;
}

export type SandboxLimitsError = ConfigParseError;

export interface SandboxConfig {
	sandbox: SandboxLimits;
	runtime: ConfinedRuntimeLimits;
}

export interface SandboxConfigDeps {
	effectiveMemory?: () => number;
}

export type SandboxConfigResult = { ok: true; config: SandboxConfig } | { ok: false; error: SandboxLimitsError };
export type SandboxLimitsResult = { ok: true; limits: SandboxLimits } | { ok: false; error: SandboxLimitsError };

/**
 * The CPU timeout stays internal and must trip before the wall-clock, so a CPU loop hits the
 * in-engine bound first and the parent kill backstops. It is clamped strictly below the
 * operator's wall-clock.
 */
function cpuTimeoutFor(wallClockMs: number): number {
	return Math.min(DEFAULT_CONFINED_LIMITS.cpuTimeoutMs, Math.floor(wallClockMs * 0.8));
}

function resolveProcesses(
	raw: unknown,
	perChildBudget: number,
	memoryBudget: number,
	effectiveMemory: number
): { ok: true; value: number } | { ok: false; error: SandboxLimitsError } {
	// 1 is the universal runnable baseline, allowed however it is specified. Unset concurrency
	// adapts to the memory budget so zero-config stays runnable on small hosts, floored to 1
	// (which may exceed the share) and capped at the default. Any value above 1, adaptive or
	// explicit, must fit the budget, so an explicit overcommit fails closed.
	if (isUnset(raw)) {
		return {
			ok: true,
			value: Math.min(DEFAULT_SANDBOX_MAX_PROCESSES, Math.max(1, Math.floor(memoryBudget / perChildBudget))),
		};
	}

	const parsed = parseCount(raw, PROCESSES_CAP);
	if (!parsed.ok) return parsed;

	if (parsed.value > 1 && parsed.value * perChildBudget > memoryBudget) {
		return {
			ok: false,
			error: {
				envVar: PROCESSES_CAP.envVar,
				message: `${PROCESSES_CAP.envVar} of ${parsed.value} needs ${formatBytes(
					parsed.value * perChildBudget
				)} of guest memory, over the ${formatBytes(
					memoryBudget
				)} sandbox budget (${SANDBOX_MEMORY_SHARE} of ${formatBytes(effectiveMemory)}). Lower ${MEMORY_CAP.envVar} or ${
					PROCESSES_CAP.envVar
				}.`,
			},
		};
	}

	return { ok: true, value: parsed.value };
}

/**
 * Resolves the operator sandbox config from env (or a config record of unknowns) into the
 * supervisor's transport and process caps and the per-invocation runtime limits, or a
 * structured error naming the offending variable. It returns the error rather than throwing,
 * so the caller decides whether a bad value blocks boot or only fails confined extensions.
 */
export function resolveSandboxConfig(
	env: Record<string, unknown> = process.env,
	deps: SandboxConfigDeps = {}
): SandboxConfigResult {
	const result = parseSize(env[RESULT_CAP.envVar], RESULT_CAP);
	if (!result.ok) return result;

	const hostApiCall = parseSize(env[HOST_API_CALL_CAP.envVar], HOST_API_CALL_CAP);
	if (!hostApiCall.ok) return hostApiCall;

	const artifact = parseSize(env[ARTIFACT_CAP.envVar], ARTIFACT_CAP);
	if (!artifact.ok) return artifact;

	const memory = parseSize(env[MEMORY_CAP.envVar], MEMORY_CAP);
	if (!memory.ok) return memory;

	const timeout = parseDuration(env[TIMEOUT_CAP.envVar], TIMEOUT_CAP);
	if (!timeout.ok) return timeout;

	const effectiveMemory = (deps.effectiveMemory ?? detectEffectiveMemory)();

	if (!Number.isFinite(effectiveMemory) || effectiveMemory <= 0) {
		return {
			ok: false,
			error: {
				envVar: MEMORY_CAP.envVar,
				message: `the effective memory budget could not be determined (got ${effectiveMemory})`,
			},
		};
	}

	const perChildBudget = cgroupMemoryMax(memory.value);

	// Even the runnable baseline of one child must fit the effective memory. A per-child
	// budget larger than the whole host or container can never run, so it fails closed
	// regardless of the process count.
	if (perChildBudget > effectiveMemory) {
		return {
			ok: false,
			error: {
				envVar: MEMORY_CAP.envVar,
				message: `one confined child needs ${formatBytes(perChildBudget)}, over the ${formatBytes(
					effectiveMemory
				)} available. Lower ${MEMORY_CAP.envVar}.`,
			},
		};
	}

	const memoryBudget = Math.floor(SANDBOX_MEMORY_SHARE * effectiveMemory);

	const processes = resolveProcesses(env[PROCESSES_CAP.envVar], perChildBudget, memoryBudget, effectiveMemory);
	if (!processes.ok) return processes;

	const maxResultBytes = result.value;
	const maxHostApiCallBytes = hostApiCall.value;
	const maxArtifactBytes = artifact.value;
	const maxProcesses = processes.value;

	// Every per-surface broker cap, plus the reply envelope, must fit under the reply
	// cap, and the canonical over-cap fallback must itself fit, or the chokepoint
	// could produce a frame the derivation below does not budget for. The surface
	// caps are bounds on the SERIALIZED reply value a surface produces (JSON
	// escaping can inflate a raw value severalfold, so a raw-bytes bound could pass
	// the surface and still breach the chokepoint). Each surface measures its
	// serialized value against its cap before replying. Constants today, asserted
	// defensively so a future edit cannot silently break the coherence.
	const surfaceCaps = [HTTP_RESPONSE_BYTES, ITEMS_REPLY_BYTES, TEMPLATE_OUTPUT_BYTES, SETTINGS_VALUE_BYTES];

	const fallbackBytes = Buffer.byteLength(
		JSON.stringify({ type: 'host-reply', id: Number.MAX_SAFE_INTEGER, reply: OVER_CAP_HOST_REPLY }),
		'utf8'
	);

	if (
		surfaceCaps.some((cap) => cap + REPLY_ENVELOPE_BYTES > BROKER_REPLY_BYTES) ||
		fallbackBytes > BROKER_REPLY_BYTES
	) {
		return {
			ok: false,
			error: {
				envVar: 'BROKER_REPLY_BYTES',
				message:
					'the broker reply caps are incoherent: every per-surface cap plus the reply envelope and the over-cap fallback must fit under the reply cap',
			},
		};
	}

	const childToParentFrameMax = Math.max(maxResultBytes, maxHostApiCallBytes) + ENVELOPE_BUDGET;

	// The job frame carries the artifact plus the invocation envelope, a host-reply
	// frame carries at most the reply cap. The child reader enforces this budget on
	// every parent-to-child frame, so it must cover whichever is larger.
	const parentToChildFrameMax = Math.max(maxArtifactBytes + INVOCATION_ENVELOPE, BROKER_REPLY_BYTES) + ENVELOPE_BUDGET;

	// Bound the parent's worst-case transient: MAX_PROCESSES children each holding a
	// child-to-parent and a parent-to-child frame buffer. The child-to-parent term is the
	// security-critical one, an untrusted child ballooning the parent.
	const transient = maxProcesses * (childToParentFrameMax + parentToChildFrameMax);

	if (transient > PARENT_MEMORY_BUDGET) {
		return {
			ok: false,
			error: {
				envVar: PROCESSES_CAP.envVar,
				message: `${PROCESSES_CAP.envVar} times the per-process frame budget (${transient} bytes) exceeds the platform sandbox memory budget of ${PARENT_MEMORY_BUDGET}. Lower ${PROCESSES_CAP.envVar} or the payload caps.`,
			},
		};
	}

	return {
		ok: true,
		config: {
			sandbox: {
				maxResultBytes,
				maxHostApiCallBytes,
				maxArtifactBytes,
				maxProcesses,
				childToParentFrameMax,
				parentToChildFrameMax,
				brokerReplyBytes: BROKER_REPLY_BYTES,
				httpResponseBytes: HTTP_RESPONSE_BYTES,
				itemsReplyBytes: ITEMS_REPLY_BYTES,
				templateOutputBytes: TEMPLATE_OUTPUT_BYTES,
				settingsValueBytes: SETTINGS_VALUE_BYTES,
			},
			runtime: {
				...DEFAULT_CONFINED_LIMITS,
				memoryBytes: memory.value,
				wallClockMs: timeout.value,
				cpuTimeoutMs: cpuTimeoutFor(timeout.value),
			},
		},
	};
}

/** The supervisor's transport and process caps, the `.sandbox` slice of the resolved config. */
export function resolveSandboxLimits(
	env: Record<string, unknown> = process.env,
	deps: SandboxConfigDeps = {}
): SandboxLimitsResult {
	const result = resolveSandboxConfig(env, deps);
	if (!result.ok) return result;
	return { ok: true, limits: result.config.sandbox };
}
