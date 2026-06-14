import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxPosture } from '../sandbox-hardening.js';
import { ConfinedSupervisor } from '../supervisor.js';
import type { ConfinedInvocation, ConfinedResult, ConfinedRuntimeLimits } from '../types.js';
import { createCountingCgroupOps, type CgroupTally } from './counting-cgroup-ops.js';

export type SoakExitPath = 'complete' | 'crash' | 'timeout' | 'oversize';

const ALL_PATHS: SoakExitPath[] = ['complete', 'crash', 'timeout', 'oversize'];

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

const SOAK_STUB_CHILD = `import net from 'node:net';
const channel = new net.Socket({ fd: 3, readable: true, writable: true });
channel.on('error', () => {});
let buf = Buffer.alloc(0);
channel.on('data', (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	while (buf.length >= 4) {
		const len = buf.readUInt32BE(0);
		if (buf.length < 4 + len) break;
		const body = buf.subarray(4, 4 + len);
		buf = buf.subarray(4 + len);
		let message = null;
		try { message = JSON.parse(body.toString('utf8')); } catch { message = null; }
		if (message && message.type === 'job') {
			const options = (message.invocation && message.invocation.options) || {};
			const mode = options.mode || 'complete';
			if (mode === 'crash') process.exit(1);
			else if (mode === 'timeout') { /* hang, the parent wall-clock kills */ }
			else if (mode === 'oversize') { const h = Buffer.allocUnsafe(4); h.writeUInt32BE(256 * 1024 * 1024, 0); channel.write(h); }
			else sendDone({ ok: true, value: 'soak' });
		}
	}
});
function sendDone(result) {
	const out = Buffer.from(JSON.stringify({ type: 'done', result }), 'utf8');
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32BE(out.length, 0);
	channel.write(Buffer.concat([header, out]), () => process.exit(0));
}
`;

export interface SoakConfig {
	count: number;
	paths?: SoakExitPath[];
}

export interface SoakResult {
	plannedPaths: Record<SoakExitPath, number>;
	observedPaths: Record<SoakExitPath, number>;
	mismatches: number;
	liveness: { active: number; queued: number };
	cgroup: CgroupTally;
}

export async function runSoak(config: SoakConfig): Promise<SoakResult> {
	const dir = mkdtempSync(join(tmpdir(), 'confined-soak-'));
	const childPath = join(dir, 'soak-child.mjs');
	writeFileSync(childPath, SOAK_STUB_CHILD);

	const counting = createCountingCgroupOps();

	const supervisor = new ConfinedSupervisor({
		childPath,
		childExecArgv: [],
		posture: DELEGATED_CGROUP_POSTURE,
		cgroupOps: counting.ops,
	});

	const plan = planPaths(config.count, config.paths ?? ALL_PATHS);
	const plannedPaths: Record<SoakExitPath, number> = { complete: 0, crash: 0, timeout: 0, oversize: 0 };
	const observedPaths: Record<SoakExitPath, number> = { complete: 0, crash: 0, timeout: 0, oversize: 0 };
	let mismatches = 0;

	try {
		for (const path of plan) {
			plannedPaths[path] += 1;
			const result = await supervisor.invoke(invocationFor(path));

			// Count the path only when the observed result matches its intended branch, so a
			// fixture that stops exercising its cleanup path fails coverage instead of passing
			// on the planned counter alone.
			if (resultCode(result) === expectedCode(path)) observedPaths[path] += 1;
			else mismatches += 1;
		}

		// invoke resolves before the child is reaped and its cgroup removed, so wait for the
		// deferred removals to fire before reading the tally.
		await settleUntil(() => counting.tally().pending === 0, 5000);

		return { plannedPaths, observedPaths, mismatches, liveness: supervisor.liveness(), cgroup: counting.tally() };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function assertSoakClean(result: SoakResult): void {
	const { plannedPaths, observedPaths, mismatches, liveness, cgroup } = result;

	// The leak proof is only meaningful if the run actually exercised each exit path, so
	// coverage is checked first.
	if (mismatches !== 0) {
		throw new Error(`exit-path mismatch: ${mismatches} invocations did not produce their intended outcome`);
	}

	for (const path of ALL_PATHS) {
		if (plannedPaths[path] === 0) throw new Error(`exit path not exercised: ${path}`);

		if (observedPaths[path] !== plannedPaths[path]) {
			throw new Error(`exit path ${path}: observed ${observedPaths[path]} of ${plannedPaths[path]} planned`);
		}
	}

	if (liveness.active !== 0) throw new Error(`slot leak: ${liveness.active} active after drain`);
	if (liveness.queued !== 0) throw new Error(`waiter leak: ${liveness.queued} queued after drain`);
	if (cgroup.created <= 0) throw new Error('cgroup proof vacuous: no cgroup was created');

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

function planPaths(count: number, mix: SoakExitPath[]): SoakExitPath[] {
	const plan: SoakExitPath[] = [];
	for (let i = 0; i < count; i++) plan.push(mix[i % mix.length]!);
	return plan;
}

function resultCode(result: ConfinedResult): string {
	return result.ok ? 'ok' : result.error.code;
}

function expectedCode(path: SoakExitPath): string {
	if (path === 'complete') return 'ok';
	if (path === 'timeout') return 'timeout';
	// crash exits the child (channel close) and oversize trips the frame-reader protocol
	// violation, both of which the supervisor surfaces as 'crash'.
	return 'crash';
}

function invocationFor(path: SoakExitPath): ConfinedInvocation {
	const limits: ConfinedRuntimeLimits =
		path === 'timeout' ? { ...BASE_LIMITS, wallClockMs: TIMEOUT_WALL_CLOCK_MS } : BASE_LIMITS;

	return {
		extensionId: 'soak.harness',
		contributionId: 'flow-operation.soak',
		operationId: 'soak',
		entrySource: '',
		options: { mode: path },
		input: null,
		accountability: null,
		limits,
	};
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
