/** Operator sandbox limits: the `EXTENSIONS_SANDBOX_*` caps, their bounds, and the derived transport frame budgets. */

import { DEFAULT_SANDBOX_MAX_PROCESSES } from './limits.js';

const KiB = 1024;
const MiB = 1024 * 1024;

// Per-frame JSON wrapper overhead beyond the payload (message type, id, envelope keys).
const ENVELOPE_BUDGET = 4 * KiB;

// The per-invocation job carries the operation options, input, accountability, and
// limits alongside the built artifact. This budgets that envelope.
const INVOCATION_ENVELOPE = 256 * KiB;

// The parent's worst-case buffered transient must stay under this platform budget.
const PARENT_MEMORY_BUDGET = 256 * MiB;

interface CapSpec {
	envVar: string;
	defaultValue: number;
	floor: number;
	ceiling: number;
}

const RESULT_CAP: CapSpec = {
	envVar: 'EXTENSIONS_SANDBOX_MAX_RESULT_BYTES',
	defaultValue: 1 * MiB,
	floor: 1 * KiB,
	ceiling: 16 * MiB,
};

const HOST_API_CALL_CAP: CapSpec = {
	envVar: 'EXTENSIONS_SANDBOX_MAX_HOST_API_CALL_BYTES',
	defaultValue: 256 * KiB,
	floor: 1 * KiB,
	ceiling: 4 * MiB,
};

const ARTIFACT_CAP: CapSpec = {
	envVar: 'EXTENSIONS_SANDBOX_MAX_ARTIFACT_BYTES',
	defaultValue: 8 * MiB,
	floor: 1 * KiB,
	ceiling: 32 * MiB,
};

const PROCESSES_CAP: CapSpec = {
	envVar: 'EXTENSIONS_SANDBOX_MAX_PROCESSES',
	defaultValue: DEFAULT_SANDBOX_MAX_PROCESSES,
	floor: 1,
	ceiling: 32,
};

export interface SandboxLimits {
	maxResultBytes: number;
	maxHostApiCallBytes: number;
	maxArtifactBytes: number;
	maxProcesses: number;
	childToParentFrameMax: number;
	parentToChildFrameMax: number;
}

export interface SandboxLimitsError {
	envVar: string;
	message: string;
}

export type SandboxLimitsResult = { ok: true; limits: SandboxLimits } | { ok: false; error: SandboxLimitsError };

function resolveCap(
	env: Record<string, string | undefined>,
	cap: CapSpec
): { ok: true; value: number } | { ok: false; error: SandboxLimitsError } {
	const raw = env[cap.envVar];

	if (raw === undefined || raw.trim() === '') return { ok: true, value: cap.defaultValue };

	const trimmed = raw.trim();

	if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
		return {
			ok: false,
			error: { envVar: cap.envVar, message: `${cap.envVar} must be a whole number of bytes, got "${raw}"` },
		};
	}

	const value = Number(trimmed);

	if (value < cap.floor) {
		return {
			ok: false,
			error: { envVar: cap.envVar, message: `${cap.envVar} must be at least ${cap.floor}, got ${value}` },
		};
	}

	if (value > cap.ceiling) {
		return {
			ok: false,
			error: { envVar: cap.envVar, message: `${cap.envVar} must be at most ${cap.ceiling}, got ${value}` },
		};
	}

	return { ok: true, value };
}

/**
 * Resolves the operator sandbox caps from env into validated limits and derived
 * frame budgets, or a structured error naming the offending variable. It returns
 * the error rather than throwing, so the caller decides whether a bad value blocks
 * boot or only fails the confined extensions.
 */
export function resolveSandboxLimits(env: Record<string, string | undefined> = process.env): SandboxLimitsResult {
	const result = resolveCap(env, RESULT_CAP);
	if (!result.ok) return result;

	const hostApiCall = resolveCap(env, HOST_API_CALL_CAP);
	if (!hostApiCall.ok) return hostApiCall;

	const artifact = resolveCap(env, ARTIFACT_CAP);
	if (!artifact.ok) return artifact;

	const processes = resolveCap(env, PROCESSES_CAP);
	if (!processes.ok) return processes;

	const maxResultBytes = result.value;
	const maxHostApiCallBytes = hostApiCall.value;
	const maxArtifactBytes = artifact.value;
	const maxProcesses = processes.value;

	const childToParentFrameMax = Math.max(maxResultBytes, maxHostApiCallBytes) + ENVELOPE_BUDGET;
	const parentToChildFrameMax = maxArtifactBytes + INVOCATION_ENVELOPE + ENVELOPE_BUDGET;

	// Bound the parent's worst-case transient: MAX_PROCESSES children each holding a
	// child-to-parent and a parent-to-child frame buffer. The child-to-parent term is
	// the security-critical one, an untrusted child ballooning the parent.
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
		limits: {
			maxResultBytes,
			maxHostApiCallBytes,
			maxArtifactBytes,
			maxProcesses,
			childToParentFrameMax,
			parentToChildFrameMax,
		},
	};
}
