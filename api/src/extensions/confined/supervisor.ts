/** The confined supervisor: spawns the child host, drives it over the framed transport on fd 3, and brokers its host calls. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolveSandboxLimits, type SandboxLimits } from './sandbox-limits.js';
import { createFrameReader, writeFrame } from './transport.js';
import type {
	ConfinedHostCallContext,
	ConfinedHostCallMessage,
	ConfinedHostDispatcher,
	ConfinedHostReply,
	ConfinedHostReplyMessage,
	ConfinedInvocation,
	ConfinedJobMessage,
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
	'items.read',
	'items.readOne',
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

function isDoneMessage(message: unknown): message is { type: 'done'; result: unknown } {
	return message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'done';
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
	// Serves brokered host calls. Defaults to denying every call.
	hostDispatcher?: ConfinedHostDispatcher;
	// Test seam: overrides the spawned child script and its node args.
	childPath?: string;
	childExecArgv?: string[];
}

/**
 * Resolves the child script from the confined directory. In the built API the production
 * target is the self-contained `runtime/child-host.mjs` bundle, run directly. In dev and
 * tests it is `child-host.ts`, run with the tsx loader. The unbundled tsc-built
 * `child-host.js` is never the spawn target. the bundle's supported path requires no
 * node_modules, and the hardened runtime-dir-only read scope blocks the deps' optional
 * imports. The directory is a parameter so the resolution can be tested against a built
 * dist tree.
 */
export function resolveChild(confinedDir = dirname(fileURLToPath(import.meta.url))): {
	path: string;
	execArgv: string[];
} {
	const bundledPath = join(confinedDir, 'runtime', 'child-host.mjs');
	if (existsSync(bundledPath)) return { path: bundledPath, execArgv: [] };

	const sourcePath = join(confinedDir, 'child-host.ts');
	return { path: sourcePath, execArgv: ['--loader', 'tsx'] };
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

export class ConfinedSupervisor {
	private readonly limits: SandboxLimits;
	private readonly maxConcurrent: number;
	private readonly hostDispatcher: ConfinedHostDispatcher;
	private readonly childPath: string;
	private readonly childExecArgv: string[];
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(options: ConfinedSupervisorOptions = {}) {
		if (options.limits !== undefined) {
			this.limits = options.limits;
		} else {
			const resolved = resolveSandboxLimits();
			if (!resolved.ok) throw new Error(`invalid sandbox limits: ${resolved.error.message}`);
			this.limits = resolved.limits;
		}

		this.maxConcurrent = this.limits.maxProcesses;
		this.hostDispatcher = options.hostDispatcher ?? denyAllHostDispatcher;

		if (options.childPath !== undefined) {
			this.childPath = options.childPath;
			this.childExecArgv = options.childExecArgv ?? [];
		} else {
			const resolved = resolveChild();
			this.childPath = resolved.path;
			this.childExecArgv = resolved.execArgv;
		}
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

	private runChild(invocation: ConfinedInvocation, dispatcher: ConfinedHostDispatcher): Promise<ConfinedResult> {
		return new Promise<ConfinedResult>((resolve) => {
			const child = spawn(process.execPath, [...this.childExecArgv, this.childPath], {
				stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
				env: childEnv(this.limits),
			});

			const channel = child.stdio[3] as Duplex | null | undefined;

			let settled = false;
			const hostCallControllers = new Set<AbortController>();

			const finish = (result: ConfinedResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);

				for (const controller of hostCallControllers) controller.abort();

				try {
					child.kill('SIGKILL');
				} catch {
					// already gone
				}

				resolve(result);
			};

			const timer = setTimeout(
				() => finish({ ok: false, error: { code: 'timeout', message: CANONICAL_ERROR_MESSAGES.timeout } }),
				invocation.limits.wallClockMs
			);

			if (!channel) {
				finish({ ok: false, error: { code: 'internal', message: CANONICAL_ERROR_MESSAGES.internal } });
				return;
			}

			const context: ConfinedHostCallContext = {
				extensionId: invocation.extensionId,
				contributionId: invocation.contributionId,
				operationId: invocation.operationId,
			};

			let hostCallTotal = 0;
			const inFlight = { count: 0 };

			const read = createFrameReader({
				maxFrameBytes: this.limits.childToParentFrameMax,
				onFrame: (message) => {
					if (settled) return;

					if (isHostCallMessage(message)) {
						hostCallTotal += 1;

						if (hostCallTotal > invocation.limits.maxHostCalls) {
							this.replyHostCall(channel, message.id, rateLimited('too many host calls'));
							return;
						}

						void this.handleHostCall(
							channel,
							message,
							context,
							invocation.limits,
							inFlight,
							hostCallControllers,
							dispatcher
						);

						return;
					}

					if (isDoneMessage(message)) finish(coerceConfinedResult(message.result));
				},
				onProtocolViolation: () =>
					finish({ ok: false, error: { code: 'crash', message: CANONICAL_ERROR_MESSAGES.crash } }),
			});

			channel.on('data', read);

			channel.on('error', () =>
				finish({ ok: false, error: { code: 'internal', message: CANONICAL_ERROR_MESSAGES.internal } })
			);

			child.on('error', () =>
				finish({ ok: false, error: { code: 'internal', message: CANONICAL_ERROR_MESSAGES.internal } })
			);

			// Treat the channel close as the child going away, not the process exit event.
			// The stream guarantees every data frame is delivered before close, so a done
			// frame the child wrote just before exiting is never lost to an exit-vs-data race.
			channel.on('close', () =>
				finish({ ok: false, error: { code: 'crash', message: CANONICAL_ERROR_MESSAGES.crash } })
			);

			const job: ConfinedJobMessage = { type: 'job', invocation };
			writeFrame(channel, job, () => undefined);
		});
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
		const replyMessage: ConfinedHostReplyMessage = { type: 'host-reply', id, reply };

		try {
			writeFrame(channel, replyMessage, () => undefined);
		} catch {
			// the child is already gone and the invocation has settled
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
