import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SandboxPosture } from '../sandbox-hardening.js';
import { resolveSandboxLimits, type SandboxLimits } from '../sandbox-limits.js';
import { ConfinedSupervisor } from '../supervisor.js';
import type {
	ConfinedHostDispatcher,
	ConfinedHostReply,
	ConfinedInvocation,
	ConfinedResult,
	ConfinedRuntimeLimits,
} from '../types.js';
import { createCountingCgroupOps, type CgroupTally } from './counting-cgroup-ops.js';

export type SoakExitPath = 'complete' | 'crash' | 'timeout' | 'oversize' | 'hostcall-timeout' | 'hostcall-flood';

const ALL_PATHS: SoakExitPath[] = ['complete', 'crash', 'timeout', 'oversize', 'hostcall-timeout', 'hostcall-flood'];

// The soak pins a small process cap so the saturation pass can drive contention with a
// known number of concurrent invocations.
const MAX_CONCURRENT = 4;

// An injected posture that drives the delegated-cgroup create/place/remove path, so the
// cgroup proof runs deterministically on any host without a real cgroup subtree. It does
// not engage namespace or permission layers, so the spawn command stays plain.
const DELEGATED_CGROUP_POSTURE: SandboxPosture = {
	mode: 'auto',
	applied: ['cgroup-memory'],
	missing: ['network-namespace', 'permission-model'],
	coreSatisfied: false,
	decision: 'run',
	cgroupMechanic: 'delegated-cgroup',
};

const BASE_LIMITS: ConfinedRuntimeLimits = {
	wallClockMs: 5000,
	cpuTimeoutMs: 2000,
	memoryBytes: 64 * 1024 * 1024,
	stackBytes: 512 * 1024,
	acquireTimeoutMs: 0,
	hostCallTimeoutMs: 5000,
	maxHostCalls: 1000,
	maxInFlightHostCalls: 16,
};

// The timeout path relies on the parent wall-clock kill, so it runs a short clock.
const TIMEOUT_WALL_CLOCK_MS = 100;
// The host-call timeout path relies on the per-call timer, so it runs a short clock under a
// wall clock long enough that the host call times out before the invocation does.
const HOST_CALL_TIMEOUT_MS = 100;
// The flood path sends more host calls than these caps so both the per-invocation total and
// the in-flight cap reject some calls.
const FLOOD_MAX_HOST_CALLS = 8;
const FLOOD_MAX_IN_FLIGHT = 4;

const SOAK_STUB_CHILD = `import net from 'node:net';
const channel = new net.Socket({ fd: 3, readable: true, writable: true });
channel.on('error', () => {});
let buf = Buffer.alloc(0);
let awaiting = 0;
let done = false;
const proof = { timeout: 0, inFlight: 0, total: 0 };
channel.on('data', (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	while (buf.length >= 4) {
		const len = buf.readUInt32BE(0);
		if (buf.length < 4 + len) break;
		const body = buf.subarray(4, 4 + len);
		buf = buf.subarray(4 + len);
		let message = null;
		try { message = JSON.parse(body.toString('utf8')); } catch { message = null; }
		if (!message) continue;
		if (message.type === 'host-reply') {
			if (awaiting > 0) {
				awaiting -= 1;
				const err = message.reply && message.reply.error;
				if (err && err.code === 'timeout') proof.timeout += 1;
				else if (err && err.message === 'too many concurrent host calls') proof.inFlight += 1;
				else if (err && err.message === 'too many host calls') proof.total += 1;
				if (awaiting === 0) sendDone({ ok: true, value: proof });
			}
			continue;
		}
		if (message.type !== 'job') continue;
		const options = (message.invocation && message.invocation.options) || {};
		const mode = options.mode || 'complete';
		if (mode === 'crash') process.exit(1);
		else if (mode === 'timeout') { /* hang, the parent wall-clock kills */ }
		else if (mode === 'oversize') { const h = Buffer.allocUnsafe(4); h.writeUInt32BE(256 * 1024 * 1024, 0); channel.write(h); }
		else if (mode === 'hostcall-timeout') { awaiting = 1; channel.write(frame({ type: 'host-call', id: 1, method: 'log.info', args: { soakMode: 'slow' } })); }
		else if (mode === 'hostcall-flood') {
			awaiting = 10;
			let batch = Buffer.alloc(0);
			for (let i = 1; i <= 10; i++) batch = Buffer.concat([batch, frame({ type: 'host-call', id: i, method: 'log.info', args: { soakMode: 'fast' } })]);
			channel.write(batch);
		}
		else sendDone({ ok: true, value: 'soak' });
	}
});
function frame(msg) {
	const out = Buffer.from(JSON.stringify(msg), 'utf8');
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32BE(out.length, 0);
	return Buffer.concat([header, out]);
}
function sendDone(result) {
	if (done) return;
	done = true;
	channel.write(frame({ type: 'done', result }), () => process.exit(0));
}
`;

export interface SoakConfig {
	count: number;
	paths?: SoakExitPath[];
}

export interface SaturationResult {
	burst: number;
	maxConcurrent: number;
	busy: number;
	queueBusy: number;
	queueRan: number;
}

export interface HostCallProof {
	// Dispatcher invocations, the calls that passed the gates.
	dispatched: number;
	// Replies the guest classified, proving each lifecycle gate actually fired.
	timeouts: number;
	inFlightDenials: number;
	totalDenials: number;
}

export interface SoakTiming {
	totalMs: number;
	perInvocationP50Ms: number;
	perInvocationP95Ms: number;
}

export interface SoakMemory {
	// heapUsed sampled after a best-effort GC, before and after the run, so a steady leak
	// shows as positive heap growth. RSS is a high-water mark that does not shrink after GC,
	// so peak RSS is reported as a capacity number, not the leak signal.
	startHeapBytes: number;
	endHeapBytes: number;
	heapGrowthBytes: number;
	peakRssBytes: number;
}

export interface SoakResult {
	plannedPaths: Record<SoakExitPath, number>;
	observedPaths: Record<SoakExitPath, number>;
	mismatches: number;
	hostCall: HostCallProof;
	saturation: SaturationResult;
	// Direct children the supervisor spawned, and any still alive after the drain. The
	// confined child cannot spawn its own descendants, so direct-child drain is the
	// complete drain for the runtime. Descendant or process-tree polling (the systemd-scope
	// case) is a later slice.
	spawnedChildren: number;
	orphanedPids: number;
	timing: SoakTiming;
	memory: SoakMemory;
	liveness: { active: number; queued: number };
	cgroup: CgroupTally;
}

export async function runSoak(config: SoakConfig): Promise<SoakResult> {
	const dir = mkdtempSync(join(tmpdir(), 'confined-soak-'));
	const childPath = join(dir, 'soak-child.mjs');
	writeFileSync(childPath, SOAK_STUB_CHILD);

	const counting = createCountingCgroupOps();
	const spawnedPids: number[] = [];
	const hostCallState = { calls: 0 };

	const supervisor = new ConfinedSupervisor({
		childPath,
		childExecArgv: [],
		posture: DELEGATED_CGROUP_POSTURE,
		cgroupOps: counting.ops,
		spawn: recordingSpawn(spawnedPids),
		hostDispatcher: countingDispatcher(hostCallState),
		limits: soakLimits(),
	});

	const plan = planPaths(config.count, config.paths ?? ALL_PATHS);
	const plannedPaths = emptyPathCounts();
	const observedPaths = emptyPathCounts();
	const hostCall: HostCallProof = { dispatched: 0, timeouts: 0, inFlightDenials: 0, totalDenials: 0 };
	const durations: number[] = [];
	let mismatches = 0;

	forceGc();
	const startHeapBytes = heapUsed();
	let peakRssBytes = rss();
	const runStart = now();

	try {
		// Drive each exit path serially and classify it by its observed outcome.
		for (const path of plan) {
			plannedPaths[path] += 1;
			const invokeStart = now();
			const result = await supervisor.invoke(invocationFor(path));
			durations.push(now() - invokeStart);
			peakRssBytes = Math.max(peakRssBytes, rss());

			// Count the path only when the observed result matches its intended branch, so a
			// fixture that stops exercising its cleanup path fails coverage instead of passing
			// on the planned counter alone.
			if (resultCode(result) === expectedCode(path)) observedPaths[path] += 1;
			else mismatches += 1;

			// The host-call guests report which lifecycle gates fired, so a dropped cap fails
			// the proof rather than passing on a single dispatcher invocation.
			accumulateHostCallProof(hostCall, path, result);
		}

		// Then drive more concurrent invocations than the process cap, so the acquire queue
		// and the busy path run under contention.
		const saturation = await runSaturation(supervisor);
		peakRssBytes = Math.max(peakRssBytes, rss());

		// invoke resolves before the child is reaped and its cgroup removed, so wait for the
		// deferred removals to fire before reading the tally.
		await settleUntil(() => counting.tally().pending === 0, 5000);

		// Independent of the cgroup tally: wait for the OS to reap every direct child the
		// supervisor spawned, then count any still alive.
		await settleUntil(() => spawnedPids.every((pid) => !isAlive(pid)), 5000);

		hostCall.dispatched = hostCallState.calls;

		forceGc();
		const endHeapBytes = heapUsed();
		// Measured at the end so it covers the serial pass, the saturation pass, and the drain.
		const totalMs = now() - runStart;

		return {
			plannedPaths,
			observedPaths,
			mismatches,
			hostCall,
			saturation,
			spawnedChildren: spawnedPids.length,
			orphanedPids: spawnedPids.filter(isAlive).length,
			timing: {
				totalMs,
				perInvocationP50Ms: percentile(durations, 50),
				perInvocationP95Ms: percentile(durations, 95),
			},
			memory: { startHeapBytes, endHeapBytes, heapGrowthBytes: endHeapBytes - startHeapBytes, peakRssBytes },
			liveness: supervisor.liveness(),
			cgroup: counting.tally(),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function assertSoakClean(result: SoakResult): void {
	const {
		plannedPaths,
		observedPaths,
		mismatches,
		hostCall,
		saturation,
		spawnedChildren,
		orphanedPids,
		liveness,
		cgroup,
	} = result;

	// The leak proof is only meaningful if the run actually exercised each path, so coverage
	// is checked first.
	if (mismatches !== 0) {
		throw new Error(`exit-path mismatch: ${mismatches} invocations did not produce their intended outcome`);
	}

	for (const path of ALL_PATHS) {
		if (plannedPaths[path] === 0) throw new Error(`exit path not exercised: ${path}`);

		if (observedPaths[path] !== plannedPaths[path]) {
			throw new Error(`exit path ${path}: observed ${observedPaths[path]} of ${plannedPaths[path]} planned`);
		}
	}

	if (hostCall.dispatched <= 0) throw new Error('host-call proof vacuous: the dispatcher was never invoked');
	if (hostCall.timeouts <= 0) throw new Error('host-call timer never fired: no timeout reply observed');
	if (hostCall.inFlightDenials <= 0) throw new Error('host-call in-flight cap never fired');
	if (hostCall.totalDenials <= 0) throw new Error('host-call total cap never fired');

	if (saturation.busy <= 0) throw new Error('saturation proof vacuous: the busy path never fired');

	if (saturation.queueBusy !== 0) {
		throw new Error(`saturation queue leak: ${saturation.queueBusy} queued invocations were rejected as busy`);
	}

	if (saturation.queueRan <= saturation.maxConcurrent) {
		throw new Error(
			`saturation queue vacuous: ${saturation.queueRan} ran, not above maxConcurrent ${saturation.maxConcurrent}`
		);
	}

	if (liveness.active !== 0) throw new Error(`slot leak: ${liveness.active} active after drain`);
	if (liveness.queued !== 0) throw new Error(`waiter leak: ${liveness.queued} queued after drain`);

	if (spawnedChildren <= 0) throw new Error('child-drain proof vacuous: no direct child was spawned');
	if (orphanedPids !== 0) throw new Error(`direct-child leak: ${orphanedPids} spawned child still alive after drain`);

	if (cgroup.created <= 0) throw new Error('cgroup proof vacuous: no cgroup was created');

	// Tie the two proofs together: every spawned child created exactly one cgroup, so a child
	// that spawned without a cgroup cannot hide behind another balanced cgroup.
	if (cgroup.created !== spawnedChildren) {
		throw new Error(`cgroup/child mismatch: ${cgroup.created} cgroups for ${spawnedChildren} spawned children`);
	}

	if (cgroup.unexpectedOps !== 0) {
		throw new Error(`cgroup op error: ${cgroup.unexpectedOps} unknown or duplicate place/remove`);
	}

	if (cgroup.placedExactlyOnce !== cgroup.created) {
		throw new Error(`cgroup placement leak: ${cgroup.placedExactlyOnce} of ${cgroup.created} placed exactly once`);
	}

	if (cgroup.removedExactlyOnce !== cgroup.created) {
		throw new Error(`cgroup removal leak: ${cgroup.removedExactlyOnce} of ${cgroup.created} removed exactly once`);
	}

	if (cgroup.pending !== 0) throw new Error(`cgroup pending leak: ${cgroup.pending} pending after drain`);
}

// The heap slope is the one judgment-prone check, so it stays out of assertSoakClean (the
// deterministic gate the bounded smoke shares) and is applied only by the heavy runner, which
// runs with GC exposed so the heap reading is clean.
export function assertHeapBounded(result: SoakResult, maxGrowthBytes: number): void {
	if (result.memory.heapGrowthBytes > maxGrowthBytes) {
		throw new Error(`heap growth ${result.memory.heapGrowthBytes} bytes exceeds bound ${maxGrowthBytes} bytes`);
	}
}

// An aggregate-only proof report: counts, timing, and memory, never request URLs, auth
// material, secret handles, raw host-call args, or per-invocation payloads.
export function buildReport(result: SoakResult): string {
	const serial = sumValues(result.plannedPaths);
	const paths = ALL_PATHS.map((path) => `${path}=${result.observedPaths[path]}`).join(' ');
	const { hostCall, saturation, cgroup, timing, memory } = result;

	return [
		'confined runtime soak report',
		`  invocations: ${serial} serial, ${saturation.burst * 2} saturation`,
		`  exit paths: ${paths}`,
		`  host calls: dispatched=${hostCall.dispatched} timeouts=${hostCall.timeouts} inFlightDenials=${hostCall.inFlightDenials} totalDenials=${hostCall.totalDenials}`,
		`  saturation: maxConcurrent=${saturation.maxConcurrent} busy=${saturation.busy} queueRan=${saturation.queueRan}`,
		`  children: spawned=${result.spawnedChildren} orphaned=${result.orphanedPids}`,
		`  cgroups: created=${cgroup.created} placed=${cgroup.placed} removed=${cgroup.removed} pending=${cgroup.pending}`,
		`  timing: total=${Math.round(timing.totalMs)}ms perInvocation p50=${timing.perInvocationP50Ms}ms p95=${
			timing.perInvocationP95Ms
		}ms`,
		`  heap after gc: start=${mb(memory.startHeapBytes)} end=${mb(memory.endHeapBytes)} growth=${mb(
			memory.heapGrowthBytes
		)}`,
		`  peak rss: ${mb(memory.peakRssBytes)}`,
	].join('\n');
}

// Drives more concurrent invocations than the process cap twice: once with no acquire wait,
// so the excess are rejected busy, and once with a wait, so the excess queue and then run.
async function runSaturation(supervisor: ConfinedSupervisor): Promise<SaturationResult> {
	const burst = MAX_CONCURRENT * 2;

	const busyBurst = await Promise.all(Array.from({ length: burst }, () => supervisor.invoke(saturationInvocation(0))));

	const queueBurst = await Promise.all(
		Array.from({ length: burst }, () => supervisor.invoke(saturationInvocation(2000)))
	);

	return {
		burst,
		maxConcurrent: MAX_CONCURRENT,
		busy: busyBurst.filter(isBusy).length,
		queueBusy: queueBurst.filter(isBusy).length,
		queueRan: queueBurst.filter((result) => result.ok).length,
	};
}

function isBusy(result: ConfinedResult): boolean {
	return !result.ok && result.error.code === 'busy';
}

// The host-call guests return the gate denials they observed in their result value, so the
// proof reflects what actually fired rather than that the dispatcher ran at all.
function accumulateHostCallProof(proof: HostCallProof, path: SoakExitPath, result: ConfinedResult): void {
	if (!result.ok || (path !== 'hostcall-timeout' && path !== 'hostcall-flood')) return;

	const value = result.value as { timeout?: number; inFlight?: number; total?: number } | null;
	if (value === null || typeof value !== 'object') return;

	proof.timeouts += value.timeout ?? 0;
	proof.inFlightDenials += value.inFlight ?? 0;
	proof.totalDenials += value.total ?? 0;
}

function emptyPathCounts(): Record<SoakExitPath, number> {
	return { complete: 0, crash: 0, timeout: 0, oversize: 0, 'hostcall-timeout': 0, 'hostcall-flood': 0 };
}

function planPaths(count: number, mix: SoakExitPath[]): SoakExitPath[] {
	const plan: SoakExitPath[] = [];
	for (let i = 0; i < count; i++) plan.push(mix[i % mix.length]!);
	return plan;
}

function resultCode(result: ConfinedResult): string {
	return result.ok ? 'ok' : result.error.code;
}

function expectedCode(path: SoakExitPath): string {
	if (path === 'timeout') return 'timeout';
	// crash exits the child (channel close) and oversize trips the frame-reader protocol
	// violation, both of which the supervisor surfaces as 'crash'.
	if (path === 'crash' || path === 'oversize') return 'crash';
	// complete and both host-call paths complete the invocation.
	return 'ok';
}

function invocationFor(path: SoakExitPath): ConfinedInvocation {
	let limits = BASE_LIMITS;

	if (path === 'timeout') limits = { ...BASE_LIMITS, wallClockMs: TIMEOUT_WALL_CLOCK_MS };
	else if (path === 'hostcall-timeout') limits = { ...BASE_LIMITS, hostCallTimeoutMs: HOST_CALL_TIMEOUT_MS };
	else if (path === 'hostcall-flood') {
		limits = { ...BASE_LIMITS, maxHostCalls: FLOOD_MAX_HOST_CALLS, maxInFlightHostCalls: FLOOD_MAX_IN_FLIGHT };
	}

	return soakInvocation(path, limits);
}

function saturationInvocation(acquireTimeoutMs: number): ConfinedInvocation {
	return soakInvocation('complete', { ...BASE_LIMITS, acquireTimeoutMs });
}

function soakInvocation(mode: SoakExitPath, limits: ConfinedRuntimeLimits): ConfinedInvocation {
	return {
		extensionId: 'soak.harness',
		contributionId: 'flow-operation.soak',
		operationId: 'soak',
		entrySource: '',
		options: { mode },
		input: null,
		accountability: null,
		limits,
	};
}

function soakLimits(): SandboxLimits {
	const resolved = resolveSandboxLimits({});
	if (!resolved.ok) throw new Error('soak: default sandbox limits should resolve');
	return { ...resolved.limits, maxProcesses: MAX_CONCURRENT };
}

function countingDispatcher(state: { calls: number }): ConfinedHostDispatcher {
	return (call, _context, signal) => {
		state.calls += 1;
		// A slow call resolves only when the supervisor aborts it (after the per-call timer),
		// so the timeout path exercises the timer and abort. A fast call resolves promptly so
		// the flood path is bounded by the caps, not by the dispatcher. The method must be a
		// real host method to pass validation, so slow vs fast travels in the args.
		const slow = (call.args as { soakMode?: string } | undefined)?.soakMode === 'slow';
		return abortableReply(signal, slow ? undefined : 10);
	};
}

function abortableReply(signal: AbortSignal, ms: number | undefined): Promise<ConfinedHostReply> {
	return new Promise((resolve) => {
		const reply: ConfinedHostReply = { ok: true, value: null };

		if (signal.aborted) {
			resolve(reply);
			return;
		}

		let timer: NodeJS.Timeout | undefined;

		const onAbort = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			resolve(reply);
		};

		signal.addEventListener('abort', onAbort, { once: true });

		if (ms !== undefined) {
			timer = setTimeout(() => {
				signal.removeEventListener('abort', onAbort);
				resolve(reply);
			}, ms);
		}
	});
}

async function settleUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (!predicate()) {
		if (Date.now() > deadline) return;
		await delay(20);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Records the pid of every direct child the supervisor spawns so the harness can prove the
// OS reaped them, independent of the cgroup tally. Delegates to the real spawn so the
// children are real.
function recordingSpawn(pids: number[]): typeof spawn {
	const wrapped = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
		const child = spawn(command, args, options);
		if (typeof child.pid === 'number') pids.push(child.pid);
		return child;
	};

	return wrapped as unknown as typeof spawn;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH means the process is gone. EPERM means it exists but is not ours, so alive.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function now(): number {
	return performance.now();
}

function rss(): number {
	return process.memoryUsage().rss;
}

function heapUsed(): number {
	return process.memoryUsage().heapUsed;
}

function forceGc(): void {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (typeof gc === 'function') gc();
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return Math.round(sorted[index]!);
}

function sumValues(counts: Record<SoakExitPath, number>): number {
	return Object.values(counts).reduce((total, value) => total + value, 0);
}

function mb(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}
