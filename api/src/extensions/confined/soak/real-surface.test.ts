import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ConfinedLogEntry } from '../broker.js';
import { runConfinedOperation, type ConfinedOperationDeps } from '../operation.js';
import {
	HTTP_RESPONSE_BYTES,
	ITEMS_REPLY_BYTES,
	SETTINGS_VALUE_BYTES,
	TEMPLATE_OUTPUT_BYTES,
} from '../sandbox-limits.js';
import { ConfinedSupervisor } from '../supervisor.js';
import type { ConfinedRuntimeLimits } from '../types.js';

// The stub-child soak proves the supervisor does not leak at scale. This is the small
// complement: repeated invocations through the real spawned child and the real broker the
// runner builds, asserting the same drain invariants so a lifecycle drift in the runner or
// broker composition (a slot never released, a child never reaped) fails here even though
// each invocation is individually correct. It leans on the structural drain checks, not a
// heap slope, which is too noisy across this few real spawns to gate on.
const REPEAT = 20;
const RUN_TIMEOUT = 60_000;
const REAP_SETTLE_MS = 5000;

const LIMITS: ConfinedRuntimeLimits = {
	wallClockMs: 5000,
	cpuTimeoutMs: 2000,
	memoryBytes: 64 * 1024 * 1024,
	stackBytes: 512 * 1024,
	acquireTimeoutMs: 0,
	hostCallTimeoutMs: 5000,
	maxHostCalls: 1000,
	maxInFlightHostCalls: 16,
};

const BROKER_LIMITS = {
	settingsValueBytes: SETTINGS_VALUE_BYTES,
	httpResponseBytes: HTTP_RESPONSE_BYTES,
	itemsReplyBytes: ITEMS_REPLY_BYTES,
	templateOutputBytes: TEMPLATE_OUTPUT_BYTES,
};

function operationEntry(handlerBody: string): string {
	return `var CairnOperation = (() => { const handler = ${handlerBody}; return { default: { id: 'canary-op', handler } }; })();`;
}

describe('confined runtime real-surface drain', () => {
	it(
		'runs repeated operations through the real child and broker without leaking a slot or child',
		async () => {
			const pids: number[] = [];
			const supervisor = new ConfinedSupervisor({ spawn: recordingSpawn(pids) });

			const logs: ConfinedLogEntry[] = [];

			const deps: ConfinedOperationDeps = {
				invoke: (invocation, dispatcher) => supervisor.invoke(invocation, dispatcher),
				log: (entry) => {
					logs.push(entry);
				},
				brokerLimits: BROKER_LIMITS,
				runtimeLimits: LIMITS,
			};

			const request = {
				extensionId: 'local.canary',
				contributionId: 'canary-op',
				operationId: 'op-1',
				entrySource: operationEntry(
					"async (_data, { host }) => { await host.log.info('canary'); return { ran: true }; }"
				),
				capabilities: { log: true },
				options: {},
				input: null,
				accountability: null,
			};

			for (let i = 0; i < REPEAT; i++) {
				const result = await runConfinedOperation(request, deps);
				expect(result.outcome).toEqual({ ok: true, value: { ran: true } });
			}

			// Every invocation reached the real broker's log path, so the broker was built and
			// dispatched on each, not short-circuited.
			expect(logs).toHaveLength(REPEAT);

			// No slot or waiter retained after the serial run.
			expect(supervisor.liveness()).toEqual({ active: 0, queued: 0 });

			// Every real child the supervisor spawned was reaped. SIGKILL and the OS reap are
			// async and the invocation resolves before the reap, so poll before sampling.
			expect(pids.length).toBeGreaterThanOrEqual(REPEAT);
			await settleUntil(() => pids.every((pid) => !isAlive(pid)), REAP_SETTLE_MS);
			expect(pids.filter(isAlive)).toEqual([]);
		},
		RUN_TIMEOUT
	);
});

// Records the pid of every real child the supervisor spawns while delegating to the real
// spawn, so the test can prove the OS reaped them.
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

async function settleUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (!predicate()) {
		if (Date.now() > deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
