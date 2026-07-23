/** The confined supervisor: spawns the child host, drives it over the framed transport on fd 3, and brokers its host calls. */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import logger from '../../logger.js';
import {
	BASELINE_POSTURE,
	buildHardenedSpawn,
	createChildCgroup,
	detectCapabilities,
	generateScopeUnit,
	HARDENING_ENV_VAR,
	killScope,
	placeInCgroup,
	reconcilePosture,
	removeCgroup,
	resolveHardeningPosture,
	validateComposedHardening,
	type ChildCgroup,
	type HardenedSpawnSpec,
	type HardeningCapabilities,
	type HardeningLayer,
	type SandboxPosture,
} from './sandbox-hardening.js';
import { cgroupMemoryMax, DEFAULT_CONFINED_LIMITS } from './limits.js';
import { OVER_CAP_HOST_REPLY, resolveSandboxConfig, type SandboxConfig, type SandboxLimits } from './sandbox-limits.js';
import { createFrameReader, writeFrame } from './transport.js';
import type {
	ConfinedHostCallContext,
	ConfinedHostCallMessage,
	ConfinedHostDispatcher,
	ConfinedHostReply,
	ConfinedHostReplyMessage,
	ConfinedInvocation,
	ConfinedJobMessage,
	ConfinedLoadProbeResult,
	ConfinedProbeJobMessage,
	ConfinedResult,
	ConfinedRuntimeErrorCode,
	ConfinedRuntimeLimits,
} from './types.js';

const ALLOWED_HOST_METHODS = new Set<string>([
	'log.debug',
	'log.info',
	'log.warn',
	'log.error',
	'request.send',
	'settings.get',
	'items.readMany',
	'items.readOne',
	'items.createOne',
	'items.createMany',
	'items.updateOne',
	'items.updateMany',
	'items.deleteOne',
	'items.deleteMany',
	'template.renderLiquid',
]);

const denyAllHostDispatcher: ConfinedHostDispatcher = async () => ({
	ok: false,
	error: { code: 'unsupported', message: 'host API is not available' },
});

// The child supplies only an error code. The parent owns the message, so a compromised
// or buggy child cannot inject option values, input, or handles into a parent-side log.
const CANONICAL_ERROR_MESSAGES: Record<ConfinedRuntimeErrorCode, string> = {
	timeout: 'the operation exceeded its time limit',
	crash: 'the confined runtime exited unexpectedly',
	'invalid-entry': 'the confined operation entry is invalid',
	'identity-mismatch': 'the confined operation identity did not match',
	'guest-error': 'the confined operation handler failed',
	'invalid-result': 'the confined operation returned an invalid result',
	busy: 'the confined runtime is at capacity',
	internal: 'the confined runtime failed',
};

const KNOWN_ERROR_CODES = new Set<ConfinedRuntimeErrorCode>(
	Object.keys(CANONICAL_ERROR_MESSAGES) as ConfinedRuntimeErrorCode[]
);

/**
 * The child runs untrusted guest code, so its result is lower-trust. The parent
 * validates the shape, replaces the message with a parent-owned canonical one keyed
 * by the code, and clamps anything malformed to an internal error.
 */
function coerceConfinedResult(value: unknown): ConfinedResult {
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;

		if (record['ok'] === true && 'value' in record) {
			return { ok: true, value: record['value'] };
		}

		if (record['ok'] === false && record['error'] !== null && typeof record['error'] === 'object') {
			const code = (record['error'] as Record<string, unknown>)['code'];

			if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code as ConfinedRuntimeErrorCode)) {
				const known = code as ConfinedRuntimeErrorCode;
				return { ok: false, error: { code: known, message: CANONICAL_ERROR_MESSAGES[known] } };
			}
		}
	}

	return { ok: false, error: { code: 'internal', message: 'the confined runtime returned an unreadable result' } };
}

/**
 * The probe verdict crosses from the lower-trust child, so its shape is validated
 * and the message replaced with a parent-owned canonical one, mirroring
 * `coerceConfinedResult`.
 */
function coerceProbeResult(value: unknown): ConfinedLoadProbeResult {
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;

		if (record['loadable'] === true) return { loadable: true };

		if (record['loadable'] === false && record['error'] !== null && typeof record['error'] === 'object') {
			const code = (record['error'] as Record<string, unknown>)['code'];

			if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code as ConfinedRuntimeErrorCode)) {
				const known = code as ConfinedRuntimeErrorCode;
				return { loadable: false, error: { code: known, message: CANONICAL_ERROR_MESSAGES[known] } };
			}
		}
	}

	return {
		loadable: false,
		error: { code: 'internal', message: 'the confined runtime returned an unreadable result' },
	};
}

function isDoneMessage(message: unknown): message is { type: 'done'; result: unknown } {
	return message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'done';
}

function isProbeDoneMessage(message: unknown): message is { type: 'probe-done'; result: unknown } {
	return message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'probe-done';
}

function isHostCallMessage(message: unknown): message is ConfinedHostCallMessage {
	if (message === null || typeof message !== 'object') return false;
	const record = message as { type?: unknown; id?: unknown };
	return (
		record.type === 'host-call' && typeof record.id === 'number' && Number.isSafeInteger(record.id) && record.id > 0
	);
}

function rateLimited(message: string): ConfinedHostReply {
	return { ok: false, error: { code: 'rate_limited', message } };
}

/**
 * Validates a host call's shape before any dispatcher work. The method must be known
 * and the payload bounded. Returns a denial reply, or null when the call is admissible.
 */
function validateHostCall(message: ConfinedHostCallMessage, maxHostApiCallBytes: number): ConfinedHostReply | null {
	if (typeof message.method !== 'string' || !ALLOWED_HOST_METHODS.has(message.method)) {
		return { ok: false, error: { code: 'unsupported', message: 'host method is not supported' } };
	}

	let size: number;

	try {
		size = Buffer.byteLength(JSON.stringify(message.args ?? null), 'utf8');
	} catch {
		return { ok: false, error: { code: 'invalid_request', message: 'host call payload is not serializable' } };
	}

	if (size > maxHostApiCallBytes) {
		return { ok: false, error: { code: 'invalid_request', message: 'host call payload is too large' } };
	}

	return null;
}

export interface ConfinedSupervisorOptions {
	// The resolved sandbox limits. When omitted, the supervisor resolves them from env.
	limits?: SandboxLimits;
	// The operator runtime maxima every invocation is clamped to. When omitted, resolved from
	// env alongside the limits, or the conservative defaults when limits are injected directly.
	runtimeLimits?: ConfinedRuntimeLimits;
	// Serves brokered host calls. Defaults to denying every call.
	hostDispatcher?: ConfinedHostDispatcher;
	// Test seam: overrides the spawned child script and its node args.
	childPath?: string;
	childExecArgv?: string[];
	// The hardening layers apply only when the resolved child is the bundle.
	isBundled?: boolean;
	// The validated OS-hardening posture. Defaults to the conservative baseline.
	posture?: SandboxPosture;
	// Test seams for the OS-hardening side effects.
	spawn?: typeof spawn;
	cgroupOps?: ConfinedCgroupOps;
	logger?: ConfinedSupervisorLogger;
}

/**
 * Resolves the child script from the confined directory. In the built API the production
 * target is the self-contained `runtime/child-host.mjs` bundle, run directly. In dev and
 * tests it is `child-host.ts`, run with tsx's import hook. The unbundled tsc-built
 * `child-host.js` is never the spawn target. the bundle's supported path requires no
 * node_modules, and the hardened runtime-dir-only read scope blocks the deps' optional
 * imports. The directory is a parameter so the resolution can be tested against a built
 * dist tree.
 */
export function resolveChild(confinedDir = dirname(fileURLToPath(import.meta.url))): {
	path: string;
	execArgv: string[];
	isBundled: boolean;
} {
	const bundledPath = join(confinedDir, 'runtime', 'child-host.mjs');
	if (existsSync(bundledPath)) return { path: bundledPath, execArgv: [], isBundled: true };

	const sourcePath = join(confinedDir, 'child-host.ts');
	return { path: sourcePath, execArgv: ['--import', 'tsx'], isBundled: false };
}

/**
 * The child never inherits the API process env beyond what it needs to start node,
 * resolve the runtime, and learn its own caps. Host secrets are not forwarded.
 */
function childEnv(limits: SandboxLimits): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH'];
	if (process.env['NODE_PATH'] !== undefined) env['NODE_PATH'] = process.env['NODE_PATH'];
	if (process.env['NODE_ENV'] !== undefined) env['NODE_ENV'] = process.env['NODE_ENV'];

	env['CONFINED_SANDBOX_LIMITS'] = JSON.stringify({
		parentToChildFrameMax: limits.parentToChildFrameMax,
		maxResultBytes: limits.maxResultBytes,
	});

	return env;
}

export interface ConfinedCgroupOps {
	killScope: (scopeUnit: string) => void;
	create: (memoryMaxBytes: number) => ChildCgroup | null;
	place: (cgroup: ChildCgroup, pid: number) => boolean;
	remove: (cgroup: ChildCgroup) => boolean;
}

const realCgroupOps: ConfinedCgroupOps = {
	killScope,
	create: createChildCgroup,
	place: placeInCgroup,
	remove: removeCgroup,
};

export interface ConfinedSupervisorLogger {
	warn(detail: Record<string, unknown>, message: string): void;
}

/**
 * Clamps a caller's requested resource limits to the operator runtime maxima. Each resource
 * field is the stricter of the requested and operator value, so a caller can narrow a limit
 * but never widen one past operator policy. The CPU timeout additionally stays strictly
 * below the clamped wall-clock so it still trips first. The fields are listed explicitly
 * rather than spread, so a new limit field cannot be added without deciding how it clamps.
 * `acquireTimeoutMs` is exempt: it is a supervisor queue policy, not a guest resource grant,
 * and the operator default of 0 would otherwise pin every invocation to reject-fast.
 */
export function clampLimits(requested: ConfinedRuntimeLimits, operator: ConfinedRuntimeLimits): ConfinedRuntimeLimits {
	const wallClockMs = Math.min(requested.wallClockMs, operator.wallClockMs);

	return {
		memoryBytes: Math.min(requested.memoryBytes, operator.memoryBytes),
		wallClockMs,
		cpuTimeoutMs: Math.min(requested.cpuTimeoutMs, operator.cpuTimeoutMs, Math.max(1, Math.floor(wallClockMs * 0.8))),
		stackBytes: Math.min(requested.stackBytes, operator.stackBytes),
		acquireTimeoutMs: requested.acquireTimeoutMs,
		hostCallTimeoutMs: Math.min(requested.hostCallTimeoutMs, operator.hostCallTimeoutMs),
		maxHostCalls: Math.min(requested.maxHostCalls, operator.maxHostCalls),
		maxInFlightHostCalls: Math.min(requested.maxInFlightHostCalls, operator.maxInFlightHostCalls),
	};
}

export class ConfinedSupervisor {
	private readonly limits: SandboxLimits;
	private readonly runtimeLimits: ConfinedRuntimeLimits;
	private readonly maxConcurrent: number;
	private readonly hostDispatcher: ConfinedHostDispatcher;
	private readonly childPath: string;
	private readonly childExecArgv: string[];
	private readonly isBundled: boolean;
	private readonly posture: SandboxPosture;
	private readonly spawnFn: typeof spawn;
	private readonly cgroupOps: ConfinedCgroupOps;
	private readonly logger: ConfinedSupervisorLogger;
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(options: ConfinedSupervisorOptions = {}) {
		if (options.limits !== undefined) {
			this.limits = options.limits;
			this.runtimeLimits = options.runtimeLimits ?? DEFAULT_CONFINED_LIMITS;
		} else {
			const resolved = resolveSandboxConfig();
			if (!resolved.ok) throw new Error(`invalid sandbox config: ${resolved.error.message}`);
			this.limits = resolved.config.sandbox;
			this.runtimeLimits = options.runtimeLimits ?? resolved.config.runtime;
		}

		this.maxConcurrent = this.limits.maxProcesses;
		this.hostDispatcher = options.hostDispatcher ?? denyAllHostDispatcher;

		if (options.childPath !== undefined) {
			this.childPath = options.childPath;
			this.childExecArgv = options.childExecArgv ?? [];
			this.isBundled = options.isBundled ?? false;
		} else {
			const resolved = resolveChild();
			this.childPath = resolved.path;
			this.childExecArgv = resolved.execArgv;
			this.isBundled = options.isBundled ?? resolved.isBundled;
		}

		this.posture = options.posture ?? BASELINE_POSTURE;

		if (this.posture.decision === 'refuse') {
			throw new Error('confined runtime refuses to start: the required OS hardening core is unavailable');
		}

		this.spawnFn = options.spawn ?? spawn;
		this.cgroupOps = options.cgroupOps ?? realCgroupOps;
		this.logger = options.logger ?? logger;
	}

	async invoke(invocation: ConfinedInvocation, hostDispatcher?: ConfinedHostDispatcher): Promise<ConfinedResult> {
		const acquired = await this.acquire(invocation.limits.acquireTimeoutMs);

		if (!acquired) {
			return { ok: false, error: { code: 'busy', message: CANONICAL_ERROR_MESSAGES.busy } };
		}

		try {
			return await this.runChild(invocation, hostDispatcher ?? this.hostDispatcher);
		} finally {
			this.release();
		}
	}

	/**
	 * Evaluates a confined entry's loadability in the spawned child under the
	 * resolved posture, never invoking the handler. A dedicated path beside
	 * `invoke`, not a flag on it, so the run contract and the probe contract
	 * cannot blend. Shares the capacity gate, so probes stay inside the
	 * fork-storm bound.
	 */
	async probeLoad(invocation: ConfinedInvocation): Promise<ConfinedLoadProbeResult> {
		const acquired = await this.acquire(invocation.limits.acquireTimeoutMs);

		if (!acquired) {
			return { loadable: false, error: { code: 'busy', message: CANONICAL_ERROR_MESSAGES.busy } };
		}

		try {
			return await this.runProbeChild(invocation);
		} finally {
			this.release();
		}
	}

	private async acquire(acquireTimeoutMs: number): Promise<boolean> {
		if (this.active < this.maxConcurrent) {
			this.active++;
			return true;
		}

		if (acquireTimeoutMs <= 0) return false;

		return new Promise<boolean>((resolve) => {
			const waiter = () => {
				clearTimeout(timer);
				this.active++;
				resolve(true);
			};

			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) this.waiters.splice(index, 1);
				resolve(false);
			}, acquireTimeoutMs);

			this.waiters.push(waiter);
		});
	}

	private release(): void {
		this.active--;
		const next = this.waiters.shift();
		if (next) next();
	}

	/** Read-only slot accounting for the soak harness to assert no slot or waiter leak after a run drains. */
	liveness(): { active: number; queued: number } {
		return { active: this.active, queued: this.waiters.length };
	}

	/**
	 * The shared child lifecycle of the run and probe paths: the hardened spawn,
	 * the cgroup placement and cleanup ordering, the wall-clock kill, and the
	 * framed channel. Frame semantics stay with the caller through `onFrame`, so
	 * the run and probe contracts never blend inside the session.
	 */
	private runChildSession<T>(options: {
		invocation: ConfinedInvocation;
		limits: ConfinedRuntimeLimits;
		job: ConfinedJobMessage | ConfinedProbeJobMessage;
		failure: (code: 'timeout' | 'crash' | 'internal') => T;
		onFrame: (message: unknown, finish: (result: T) => void, channel: Duplex) => void;
		onFinish?: () => void;
	}): Promise<T> {
		const { invocation, limits, job, failure, onFrame, onFinish } = options;

		return new Promise<T>((resolve) => {
			const spec: HardenedSpawnSpec = {
				execPath: process.execPath,
				childExecArgv: this.childExecArgv,
				childPath: this.childPath,
				runtimeDir: dirname(this.childPath),
				isBundled: this.isBundled,
				memoryMaxBytes: cgroupMemoryMax(limits.memoryBytes),
				scopeUnit: generateScopeUnit(),
				childEnv: childEnv(this.limits),
				busEnv: {
					DBUS_SESSION_BUS_ADDRESS: process.env['DBUS_SESSION_BUS_ADDRESS'],
					XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'],
				},
			};

			const built = buildHardenedSpawn(this.posture, spec);
			const cgroup = this.createDelegatedCgroup(spec.memoryMaxBytes, invocation);

			const child = this.spawnFn(built.command, built.args, {
				stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
				env: built.env,
			});

			if (cgroup !== null) this.placeChildInCgroup(cgroup, child.pid, invocation);

			const channel = child.stdio[3] as Duplex | null | undefined;

			let settled = false;

			const finish = (result: T) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);

				onFinish?.();

				if (built.scopeUnit !== null) this.cgroupOps.killScope(built.scopeUnit);

				try {
					child.kill('SIGKILL');
				} catch {
					// already gone
				}

				if (cgroup !== null) this.removeCgroupWhenExited(child, cgroup, invocation);

				resolve(result);
			};

			const timer = setTimeout(() => finish(failure('timeout')), limits.wallClockMs);

			if (!channel) {
				finish(failure('internal'));
				return;
			}

			const read = createFrameReader({
				maxFrameBytes: this.limits.childToParentFrameMax,
				onFrame: (message) => {
					if (settled) return;
					onFrame(message, finish, channel);
				},
				onProtocolViolation: () => finish(failure('crash')),
			});

			channel.on('data', read);
			channel.on('error', () => finish(failure('internal')));
			child.on('error', () => finish(failure('internal')));

			// Treat the channel close as the child going away, not the process exit event.
			// The stream guarantees every data frame is delivered before close, so a done
			// frame the child wrote just before exiting is never lost to an exit-vs-data race.
			channel.on('close', () => finish(failure('crash')));

			// A non-JSON-safe payload throws in the frame writer. Resolve a structured
			// failure rather than rejecting the session promise.
			try {
				writeFrame(channel, job, () => undefined);
			} catch {
				finish(failure('internal'));
			}
		});
	}

	private runChild(invocation: ConfinedInvocation, dispatcher: ConfinedHostDispatcher): Promise<ConfinedResult> {
		// Every invocation is clamped to the operator runtime maxima, so a caller cannot
		// request looser limits than operator policy allows.
		const limits = clampLimits(invocation.limits, this.runtimeLimits);
		const effective: ConfinedInvocation = { ...invocation, limits };

		const context: ConfinedHostCallContext = {
			extensionId: invocation.extensionId,
			contributionId: invocation.contributionId,
			operationId: invocation.operationId,
		};

		let hostCallTotal = 0;
		const inFlight = { count: 0 };
		const hostCallControllers = new Set<AbortController>();

		return this.runChildSession<ConfinedResult>({
			invocation: effective,
			limits,
			job: { type: 'job', invocation: effective },
			failure: (code) => ({ ok: false, error: { code, message: CANONICAL_ERROR_MESSAGES[code] } }),
			onFinish: () => {
				for (const controller of hostCallControllers) controller.abort();
			},
			onFrame: (message, finish, channel) => {
				if (isHostCallMessage(message)) {
					hostCallTotal += 1;

					if (hostCallTotal > limits.maxHostCalls) {
						this.replyHostCall(channel, message.id, rateLimited('too many host calls'));
						return;
					}

					void this.handleHostCall(channel, message, context, limits, inFlight, hostCallControllers, dispatcher);

					return;
				}

				if (isDoneMessage(message)) finish(coerceConfinedResult(message.result));
			},
		});
	}

	private runProbeChild(invocation: ConfinedInvocation): Promise<ConfinedLoadProbeResult> {
		const limits = clampLimits(invocation.limits, this.runtimeLimits);
		const effective: ConfinedInvocation = { ...invocation, limits };

		const failure = (code: 'timeout' | 'crash' | 'internal'): ConfinedLoadProbeResult => ({
			loadable: false,
			error: { code, message: CANONICAL_ERROR_MESSAGES[code] },
		});

		return this.runChildSession<ConfinedLoadProbeResult>({
			invocation: effective,
			limits,
			job: { type: 'probe', invocation: effective },
			failure,
			onFrame: (message, finish) => {
				// The probe engine answers host calls deny-all in-process, so a host-call
				// frame on this path is a contract violation from the child.
				if (isHostCallMessage(message)) {
					finish(failure('crash'));
					return;
				}

				if (isProbeDoneMessage(message)) finish(coerceProbeResult(message.result));
			},
		});
	}

	private createDelegatedCgroup(memoryMaxBytes: number, invocation: ConfinedInvocation): ChildCgroup | null {
		if (this.posture.cgroupMechanic !== 'delegated-cgroup' || !this.posture.applied.includes('cgroup-memory')) {
			return null;
		}

		const cgroup = this.cgroupOps.create(memoryMaxBytes);

		if (cgroup === null) {
			this.logger.warn(
				{ extensionId: invocation.extensionId, contributionId: invocation.contributionId },
				'confined memory cgroup unavailable, falling back to the wall-clock backstop'
			);
		}

		return cgroup;
	}

	private placeChildInCgroup(cgroup: ChildCgroup, pid: number | undefined, invocation: ConfinedInvocation): void {
		if (pid !== undefined && this.cgroupOps.place(cgroup, pid)) return;

		this.logger.warn(
			{ extensionId: invocation.extensionId, contributionId: invocation.contributionId },
			'confined child could not be placed in its memory cgroup, falling back to the wall-clock backstop'
		);
	}

	private removeCgroupWhenExited(child: ChildProcess, cgroup: ChildCgroup, invocation: ConfinedInvocation): void {
		const remove = () => {
			if (this.cgroupOps.remove(cgroup)) return;

			this.logger.warn(
				{ extensionId: invocation.extensionId, contributionId: invocation.contributionId },
				'confined memory cgroup could not be removed after the child exited'
			);
		};

		if (child.exitCode !== null || child.signalCode !== null) {
			remove();
		} else {
			child.once('exit', remove);
		}
	}

	private async handleHostCall(
		channel: Duplex,
		message: ConfinedHostCallMessage,
		context: ConfinedHostCallContext,
		limits: ConfinedRuntimeLimits,
		inFlight: { count: number },
		controllers: Set<AbortController>,
		dispatcher: ConfinedHostDispatcher
	): Promise<void> {
		const invalid = validateHostCall(message, this.limits.maxHostApiCallBytes);

		if (invalid !== null) {
			this.replyHostCall(channel, message.id, invalid);
			return;
		}

		if (inFlight.count >= limits.maxInFlightHostCalls) {
			this.replyHostCall(channel, message.id, rateLimited('too many concurrent host calls'));
			return;
		}

		inFlight.count += 1;

		const controller = new AbortController();
		controllers.add(controller);
		const dispatched = this.invokeDispatcher(dispatcher, message, context, controller.signal);

		void dispatched.finally(() => {
			inFlight.count -= 1;
			controllers.delete(controller);
		});

		let timer: NodeJS.Timeout | undefined;

		const timeout = new Promise<ConfinedHostReply>((resolve) => {
			timer = setTimeout(
				() => resolve({ ok: false, error: { code: 'timeout', message: 'the host call timed out' } }),
				limits.hostCallTimeoutMs
			);
		});

		let reply: ConfinedHostReply;

		try {
			reply = await Promise.race([dispatched, timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}

		controller.abort();
		this.replyHostCall(channel, message.id, reply);
	}

	private replyHostCall(channel: Duplex, id: number, reply: ConfinedHostReply): void {
		let replyMessage: ConfinedHostReplyMessage = { type: 'host-reply', id, reply };

		// The chokepoint reply guard: a serialized reply over the broker-reply cap is
		// replaced with the canonical over-cap error, so no dispatcher can produce a
		// host-reply frame the child reader must reject as a protocol violation. The
		// cap fits the parent-to-child frame budget by derivation.
		try {
			if (Buffer.byteLength(JSON.stringify(replyMessage), 'utf8') > this.limits.brokerReplyBytes) {
				replyMessage = { type: 'host-reply', id, reply: OVER_CAP_HOST_REPLY };
			}
		} catch {
			// a non-serializable reply falls through to the writer's own guard below
		}

		try {
			writeFrame(channel, replyMessage, () => undefined);
		} catch {
			// A non-JSON-safe reply value throws in the frame writer while the guest is
			// still waiting on this id, so send a serializable error reply rather than
			// leaving the guest to hang to its host-call timeout. A second throw means the
			// child is already gone and the invocation has settled.
			const fallback: ConfinedHostReplyMessage = {
				type: 'host-reply',
				id,
				reply: { ok: false, error: { code: 'internal', message: 'the host call failed' } },
			};

			try {
				writeFrame(channel, fallback, () => undefined);
			} catch {
				// the child is already gone and the invocation has settled
			}
		}
	}

	private async invokeDispatcher(
		dispatcher: ConfinedHostDispatcher,
		message: ConfinedHostCallMessage,
		context: ConfinedHostCallContext,
		signal: AbortSignal
	): Promise<ConfinedHostReply> {
		try {
			return await dispatcher({ method: message.method, args: message.args }, context, signal);
		} catch {
			return { ok: false, error: { code: 'internal', message: 'the host call failed' } };
		}
	}
}

let supervisor: ConfinedSupervisor | undefined;

export function getConfinedSupervisor(): ConfinedSupervisor {
	if (supervisor === undefined) supervisor = new ConfinedSupervisor();
	return supervisor;
}

export type ConfinedRuntimeResolution =
	| { ok: true; supervisor: ConfinedSupervisor; config: SandboxConfig; posture: SandboxPosture }
	| { ok: false; error: { envVar?: string; message: string } };

export interface ResolveConfinedRuntimeDeps {
	env?: Record<string, string | undefined>;
	detect?: (execPath: string, env: Record<string, string | undefined>) => HardeningCapabilities;
	validate?: (intended: SandboxPosture, spec: HardenedSpawnSpec) => Promise<HardeningLayer[]>;
	resolveChild?: typeof resolveChild;
	makeSupervisor?: (options: ConfinedSupervisorOptions) => ConfinedSupervisor;
}

/**
 * The production confined-runtime boot. Resolves the operator sandbox config and
 * the intended OS-hardening posture, runs the composed self-check that confirms
 * each candidate layer works end to end on this host, reconciles the posture to
 * what actually ran, and constructs one supervisor under it. A config or posture
 * failure, or a `required`-mode host that cannot satisfy the hardening core,
 * returns an error the caller fails confined extensions closed with, never
 * touching inherited extensions. The composition lives here because it reuses
 * the exact spawn spec the supervisor builds per invocation, so the self-check
 * validates the same command the runtime will run.
 */
export async function resolveConfinedRuntime(
	deps: ResolveConfinedRuntimeDeps = {}
): Promise<ConfinedRuntimeResolution> {
	const env = deps.env ?? process.env;
	const detect = deps.detect ?? detectCapabilities;
	const validate = deps.validate ?? validateComposedHardening;
	const resolveChildFn = deps.resolveChild ?? resolveChild;

	const makeSupervisor =
		deps.makeSupervisor ?? ((options: ConfinedSupervisorOptions) => new ConfinedSupervisor(options));

	const configResult = resolveSandboxConfig(env);

	if (!configResult.ok) {
		return { ok: false, error: { envVar: configResult.error.envVar, message: configResult.error.message } };
	}

	const config = configResult.config;

	try {
		const child = resolveChildFn();
		const intended = resolveHardeningPosture(env, detect(process.execPath, env));

		if (!intended.ok) {
			return { ok: false, error: { envVar: intended.error.envVar, message: intended.error.message } };
		}

		const spec: HardenedSpawnSpec = {
			execPath: process.execPath,
			childExecArgv: child.execArgv,
			childPath: child.path,
			runtimeDir: dirname(child.path),
			isBundled: child.isBundled,
			memoryMaxBytes: cgroupMemoryMax(config.runtime.memoryBytes),
			scopeUnit: generateScopeUnit(),
			childEnv: childEnv(config.sandbox),
			busEnv: {
				DBUS_SESSION_BUS_ADDRESS: env['DBUS_SESSION_BUS_ADDRESS'],
				XDG_RUNTIME_DIR: env['XDG_RUNTIME_DIR'],
			},
		};

		// The unbundled dev child spawns pure baseline (buildHardenedSpawn drops every
		// layer when isBundled is false), so no OS layer can apply regardless of what the
		// self-check would report. Forcing no validated layers keeps the posture honest:
		// auto runs baseline, required refuses for the unconfinable dev child.
		const validatedLayers = child.isBundled ? await validate(intended.posture, spec) : [];
		const posture = reconcilePosture(intended.posture, validatedLayers);

		if (posture.decision === 'refuse') {
			return {
				ok: false,
				error: { envVar: HARDENING_ENV_VAR, message: 'the required OS hardening core is unavailable on this host' },
			};
		}

		return {
			ok: true,
			supervisor: makeSupervisor({
				limits: config.sandbox,
				runtimeLimits: config.runtime,
				posture,
				// The supervisor runs the exact child the self-check validated, not a
				// second resolveChild() that could diverge.
				childPath: child.path,
				childExecArgv: child.execArgv,
				isBundled: child.isBundled,
			}),
			config,
			posture,
		};
	} catch {
		// Detection, the composed self-check, or construction failed. Fail confined
		// extensions closed without leaking host detail, leaving inherited extensions
		// to the caller.
		return { ok: false, error: { message: 'the confined runtime could not be initialized' } };
	}
}
