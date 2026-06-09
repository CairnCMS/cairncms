/** The OS-hardening posture: capability detection, posture resolution, and the composed
 * hardened spawn. A portable baseline always runs. this layer composes the OS primitives
 * the host offers (a network namespace, the Node permission model with a runtime-dir-scoped
 * read, and a cgroup memory cap), surfaces what is missing, and refuses confined extensions
 * only in `required` mode on a host without the escape-containment core. */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { createFrameReader, writeFrame } from './transport.js';
import type { ConfinedResult } from './types.js';

export type HardeningLayer = 'network-namespace' | 'permission-model' | 'cgroup-memory';
export type HardeningMode = 'auto' | 'required';
export type CgroupMechanic = 'systemd-run' | 'delegated-cgroup';

const ALL_LAYERS: HardeningLayer[] = ['network-namespace', 'permission-model', 'cgroup-memory'];

// The escape-containment core. The cgroup cap stays best-effort even under `required`. The
// scoped fs-read is intrinsic to `permission-model`, not a separate layer.
const REQUIRED_CORE: HardeningLayer[] = ['network-namespace', 'permission-model'];

const HARDENING_ENV_VAR = 'EXTENSIONS_SANDBOX_OS_HARDENING';

export interface HardeningCapabilities {
	networkNamespace: boolean;
	permissionModel: boolean;
	cgroupMemory: { mechanic: CgroupMechanic } | null;
}

export interface SandboxPosture {
	mode: HardeningMode;
	applied: HardeningLayer[];
	missing: HardeningLayer[];
	coreSatisfied: boolean;
	decision: 'run' | 'refuse';
	cgroupMechanic: CgroupMechanic | null;
}

export interface HardeningError {
	envVar: string;
	message: string;
}

export type HardeningResolution = { ok: true; posture: SandboxPosture } | { ok: false; error: HardeningError };

// Baseline with no OS hardening: a synchronous construction cannot run the async composed
// validation, so it must never claim a layer it has not confirmed.
export const BASELINE_POSTURE: SandboxPosture = {
	mode: 'auto',
	applied: [],
	missing: [...ALL_LAYERS],
	coreSatisfied: false,
	decision: 'run',
	cgroupMechanic: null,
};

function posture(
	mode: HardeningMode,
	applied: HardeningLayer[],
	cgroupMechanic: CgroupMechanic | null
): SandboxPosture {
	const ordered = ALL_LAYERS.filter((layer) => applied.includes(layer));
	const coreSatisfied = REQUIRED_CORE.every((layer) => ordered.includes(layer));

	return {
		mode,
		applied: ordered,
		missing: ALL_LAYERS.filter((layer) => !ordered.includes(layer)),
		coreSatisfied,
		decision: mode === 'required' && !coreSatisfied ? 'refuse' : 'run',
		cgroupMechanic: ordered.includes('cgroup-memory') ? cgroupMechanic : null,
	};
}

function availableLayers(capabilities: HardeningCapabilities): HardeningLayer[] {
	const layers: HardeningLayer[] = [];
	if (capabilities.networkNamespace) layers.push('network-namespace');
	if (capabilities.permissionModel) layers.push('permission-model');
	if (capabilities.cgroupMemory) layers.push('cgroup-memory');
	return layers;
}

/**
 * Resolves the intended posture from the operator mode and the detected capabilities.
 * Unset or empty is `auto`. a malformed value is a structured error the caller turns into
 * not-runnable. the returned posture is reconciled with `validateComposedHardening` before
 * use.
 */
export function resolveHardeningPosture(
	env: Record<string, string | undefined>,
	capabilities: HardeningCapabilities
): HardeningResolution {
	const raw = env[HARDENING_ENV_VAR];
	const trimmed = raw?.trim() ?? '';
	const mode = trimmed === '' ? 'auto' : trimmed;

	if (mode !== 'auto' && mode !== 'required') {
		return {
			ok: false,
			error: { envVar: HARDENING_ENV_VAR, message: `${HARDENING_ENV_VAR} must be "auto" or "required", got "${raw}"` },
		};
	}

	return {
		ok: true,
		posture: posture(mode, availableLayers(capabilities), capabilities.cgroupMemory?.mechanic ?? null),
	};
}

/**
 * Recomputes the posture from the set of layers the composed validation confirmed work end
 * to end, so `coreSatisfied` and `decision` reflect what actually runs, not primitive
 * availability.
 */
export function reconcilePosture(intended: SandboxPosture, validatedLayers: HardeningLayer[]): SandboxPosture {
	return posture(intended.mode, validatedLayers, intended.cgroupMechanic);
}

/**
 * The candidate layer sets `validateComposedHardening` tries, most protection first and
 * always subsets of `intended` (so the validator never tries a layer `detectCapabilities`
 * did not report). De-duped, so an absent layer collapses its candidate into an earlier one.
 */
export function candidateLayerSets(intended: HardeningLayer[]): HardeningLayer[][] {
	const subset = (of: HardeningLayer[]) => intended.filter((layer) => of.includes(layer));

	const raw: HardeningLayer[][] = [
		intended,
		intended.filter((layer) => layer !== 'cgroup-memory'),
		subset(['permission-model']),
		subset(['network-namespace']),
		[],
	];

	const seen = new Set<string>();
	const candidates: HardeningLayer[][] = [];

	for (const candidate of raw) {
		const key = candidate.join(',');
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push(candidate);
	}

	return candidates;
}

export interface HardenedSpawnSpec {
	execPath: string;
	childExecArgv: string[];
	childPath: string;
	runtimeDir: string;
	isBundled: boolean;
	memoryMaxBytes: number;
	scopeUnit: string;
	// The env offered to the child. The bundled path reduces it to a fixed allowlist before
	// the child sees it, so the caller cannot widen the hardened child's env.
	childEnv: Record<string, string | undefined>;
	// The session-bus env systemd-run needs, kept off the child by `env -i`.
	busEnv: Record<string, string | undefined>;
}

export interface HardenedSpawn {
	command: string;
	args: string[];
	env: Record<string, string>;
	scopeUnit: string | null;
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>;
}

// The only env the hardened bundled child may receive. PATH lets it find node, and the
// limits payload carries its resolved caps. Anything else (NODE_PATH, NODE_OPTIONS, the
// session bus) is dropped here so the child cannot be steered by inherited env, whatever
// the caller passes.
const BUNDLED_CHILD_ENV_ALLOWLIST = ['PATH', 'CONFINED_SANDBOX_LIMITS'];

function bundledChildEnv(env: Record<string, string | undefined>): Record<string, string> {
	const allowed: Record<string, string> = {};

	for (const key of BUNDLED_CHILD_ENV_ALLOWLIST) {
		const value = env[key];
		if (value !== undefined) allowed[key] = value;
	}

	return allowed;
}

/**
 * Composes the production hardened spawn from the posture's applied layers, innermost
 * first: the permission model, then the network namespace, then the systemd-run cgroup
 * wrapper. The systemd-run path interposes `env -i` so the session bus the wrapper needs
 * never reaches the child. The bundled child receives only the allowlisted env. The dev
 * path is always the plain baseline.
 */
export function buildHardenedSpawn(posture: SandboxPosture, spec: HardenedSpawnSpec): HardenedSpawn {
	if (!spec.isBundled) {
		const env = definedEnv(spec.childEnv);
		return { command: spec.execPath, args: [...spec.childExecArgv, spec.childPath], env, scopeUnit: null };
	}

	const childEnv = bundledChildEnv(spec.childEnv);
	let command = spec.execPath;
	let args = [spec.childPath];

	if (posture.applied.includes('permission-model')) {
		args = ['--permission', `--allow-fs-read=${spec.runtimeDir}`, ...args];
	}

	if (posture.applied.includes('network-namespace')) {
		args = ['-rn', command, ...args];
		command = 'unshare';
	}

	if (posture.applied.includes('cgroup-memory') && posture.cgroupMechanic === 'systemd-run') {
		const envI = ['env', '-i', ...Object.entries(childEnv).map(([key, value]) => `${key}=${value}`)];

		args = [
			'--user',
			'--scope',
			`--unit=${spec.scopeUnit}`,
			'-p',
			`MemoryMax=${spec.memoryMaxBytes}`,
			'-p',
			'MemorySwapMax=0',
			...envI,
			command,
			...args,
		];

		command = 'systemd-run';
		return { command, args, env: { ...childEnv, ...definedEnv(spec.busEnv) }, scopeUnit: spec.scopeUnit };
	}

	return { command, args, env: childEnv, scopeUnit: null };
}

/** The boot-log shape: the mode, the applied layers, the missing layers, and the cgroup mechanic. */
export function describePosture(posture: SandboxPosture): string {
	const applied = posture.applied.length > 0 ? posture.applied.join(', ') : 'none';
	const missing = posture.missing.length > 0 ? posture.missing.join(', ') : 'none';
	const cgroup = posture.cgroupMechanic ? ` cgroup=${posture.cgroupMechanic}` : '';
	return `confined OS hardening: mode=${posture.mode} decision=${posture.decision} applied=[${applied}] missing=[${missing}]${cgroup}`;
}

/** Generates a unique-per-invocation systemd scope unit name so concurrent children never collide. */
export function generateScopeUnit(): string {
	return `cairn-confined-${randomUUID()}.scope`;
}

/**
 * Terminates a systemd-run scope by unit, killing every process in it so the node child
 * inside the scope cannot be orphaned. Best-effort, the wall-clock kill is the bound.
 */
export function killScope(scopeUnit: string): void {
	try {
		spawnSync('systemctl', ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', scopeUnit], { stdio: 'ignore' });
		spawnSync('systemctl', ['--user', 'stop', scopeUnit], { stdio: 'ignore' });
	} catch {
		// the scope is already gone
	}
}

// ---- OS primitive probes ----

function probeNetworkNamespace(): boolean {
	const result = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' });
	return !result.error && result.status === 0;
}

function probePermissionModel(execPath: string): boolean {
	const result = spawnSync(execPath, ['--permission', '-e', ''], { stdio: 'ignore' });
	return !result.error && result.status === 0;
}

function delegatedCgroupRoot(): string | null {
	try {
		const line = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n')[0] ?? '';
		const rel = line.split(':').pop() ?? '';
		const dir = join('/sys/fs/cgroup', rel);
		const controllers = readFileSync(join(dir, 'cgroup.controllers'), 'utf8');
		if (!controllers.split(/\s+/).includes('memory')) return null;

		// A creatable child cgroup is not enough: the memory controller is usable in a child
		// only when memory is active in the parent subtree_control, so the probe must get the
		// writable memory.max and memory.swap.max that createChildCgroup writes. A privileged
		// container's cgroup root is writable but delegates no memory. The write probe
		// separates a real delegated subtree from that false positive.
		const probe = join(dir, `.cairn-probe-${randomUUID()}`);
		mkdirSync(probe);

		try {
			writeFileSync(join(probe, 'memory.max'), 'max');
			writeFileSync(join(probe, 'memory.swap.max'), 'max');
		} catch {
			return null;
		} finally {
			try {
				rmdirSync(probe);
			} catch {
				// the empty probe cgroup is already gone
			}
		}

		return dir;
	} catch {
		return null;
	}
}

function probeSystemdRun(env: Record<string, string | undefined>): boolean {
	if (!env['DBUS_SESSION_BUS_ADDRESS'] && !env['XDG_RUNTIME_DIR']) return false;
	const result = spawnSync('systemd-run', ['--user', '--version'], { stdio: 'ignore' });
	return !result.error && result.status === 0;
}

function detectCgroupMechanic(env: Record<string, string | undefined>): { mechanic: CgroupMechanic } | null {
	if (delegatedCgroupRoot()) return { mechanic: 'delegated-cgroup' };
	if (probeSystemdRun(env)) return { mechanic: 'systemd-run' };
	return null;
}

/** Probes each OS primitive in isolation. primitive availability only, not that the composed wrapper works (that is `validateComposedHardening`). */
export function detectCapabilities(
	execPath: string = process.execPath,
	env: Record<string, string | undefined> = process.env
): HardeningCapabilities {
	return {
		networkNamespace: probeNetworkNamespace(),
		permissionModel: probePermissionModel(execPath),
		cgroupMemory: detectCgroupMechanic(env),
	};
}

// The probe only needs the engine to load and return under the candidate spawn, so the
// validation job is trivial.
const VALIDATION_JOB = {
	type: 'job',
	invocation: {
		extensionId: 'local.self-check',
		contributionId: 'flow-operation.self-check',
		operationId: 'self-check',
		entrySource:
			"var CairnOperation = (() => { const handler = async () => ({ ok: true }); return { default: { id: 'flow-operation.self-check', handler } }; })();",
		options: {},
		input: null,
		accountability: null,
		limits: {
			wallClockMs: 8000,
			cpuTimeoutMs: 4000,
			memoryBytes: 64 * 1024 * 1024,
			stackBytes: 512 * 1024,
			acquireTimeoutMs: 0,
			hostCallTimeoutMs: 4000,
			maxHostCalls: 0,
			maxInFlightHostCalls: 0,
		},
	},
};

function probeComposedSpawn(spawned: HardenedSpawn): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;

		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);

			try {
				if (spawned.scopeUnit) killScope(spawned.scopeUnit);
				child.kill('SIGKILL');
			} catch {
				// already gone
			}

			resolve(ok);
		};

		const child = spawn(spawned.command, spawned.args, {
			stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
			env: spawned.env,
		});

		const timer = setTimeout(() => finish(false), 12_000);
		const channel = child.stdio[3] as Duplex | null | undefined;

		if (!channel) {
			finish(false);
			return;
		}

		channel.on('error', () => finish(false));
		child.on('error', () => finish(false));
		child.on('close', () => finish(false));

		channel.on(
			'data',
			createFrameReader({
				maxFrameBytes: 16 * 1024 * 1024,
				onFrame: (message) => {
					const record = message as { type?: string; result?: ConfinedResult };
					if (record.type === 'done') finish(record.result?.ok === true);
				},
				onProtocolViolation: () => finish(false),
			})
		);

		writeFrame(channel, VALIDATION_JOB, () => undefined);
	});
}

/**
 * The authoritative self-check. For each candidate layer set (subsets of the intended
 * posture's layers, most protection first) it builds the EXACT spawn `buildHardenedSpawn`
 * would produce and runs it against a trivial job over fd-3, returning the largest candidate
 * that works end to end. The caller reconciles the posture from the returned set.
 *
 * Under the systemd-run mechanic the cgroup cap is part of the composed command, so a
 * candidate including `cgroup-memory` is validated as a whole and the cgroup is never
 * accepted in isolation. The delegated mechanic applies the cap after spawn, which this
 * spawn-only check cannot exercise, so `cgroup-memory` is excluded from validation there and
 * the posture under-claims rather than report a cap it did not confirm.
 */
export async function validateComposedHardening(
	intended: SandboxPosture,
	spec: HardenedSpawnSpec,
	probe: (spawned: HardenedSpawn) => Promise<boolean> = probeComposedSpawn
): Promise<HardeningLayer[]> {
	const validatable =
		intended.cgroupMechanic === 'delegated-cgroup'
			? intended.applied.filter((layer) => layer !== 'cgroup-memory')
			: intended.applied;

	for (const candidate of candidateLayerSets(validatable)) {
		const candidatePosture = posture(intended.mode, candidate, intended.cgroupMechanic);
		const spawned = buildHardenedSpawn(candidatePosture, spec);
		if (await probe(spawned)) return candidate;
	}

	return [];
}

// ---- delegated cgroup helpers (the mechanic used where a writable subtree exists) ----

export interface ChildCgroup {
	path: string;
}

/** Creates a per-child cgroup with `memory.max` set, or null when no delegated subtree is writable. */
export function createChildCgroup(memoryMaxBytes: number): ChildCgroup | null {
	const root = delegatedCgroupRoot();
	if (!root) return null;

	const path = join(root, `cairn-confined-${randomUUID()}`);

	try {
		mkdirSync(path);
		writeFileSync(join(path, 'memory.max'), String(memoryMaxBytes));
		writeFileSync(join(path, 'memory.swap.max'), '0');
		return { path };
	} catch {
		// A write after mkdir can fail, so remove the half-created cgroup rather than leak it.
		try {
			rmdirSync(path);
		} catch {
			// nothing was created, or it is already gone
		}

		return null;
	}
}

/** Places a spawned child into the cgroup. Best-effort. */
export function placeInCgroup(cgroup: ChildCgroup, pid: number): boolean {
	try {
		writeFileSync(join(cgroup.path, 'cgroup.procs'), String(pid));
		return true;
	} catch {
		return false;
	}
}

/**
 * Removes the emptied per-child cgroup, returning whether it succeeded. cgroup v2 refuses to
 * remove a populated cgroup, so the caller must wait for the child to exit first.
 */
export function removeCgroup(cgroup: ChildCgroup): boolean {
	try {
		rmdirSync(cgroup.path);
		return true;
	} catch {
		return false;
	}
}
