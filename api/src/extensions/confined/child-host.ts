/** The confined child host: runs the QuickJS engine out of the API process and talks to the parent over the framed transport on fd 3. */

import net from 'node:net';
import { runConfinedEntry, runConfinedLoadProbe } from './engine.js';
import { createFrameReader, writeFrame } from './transport.js';
import type {
	ConfinedDoneMessage,
	ConfinedHostCall,
	ConfinedHostCallMessage,
	ConfinedHostReply,
	ConfinedJobMessage,
	ConfinedLoadProbeResult,
	ConfinedProbeDoneMessage,
	ConfinedProbeJobMessage,
	ConfinedResult,
} from './types.js';

// The parent always supplies the resolved sandbox caps. A missing, malformed, or
// partial payload means a broken parent/child wiring, so the child fails closed rather
// than run under caps that differ from the operator's resolved limits.
const limits = readLimits();

// The protocol runs over the reserved fd 3, never stdin or stdout, so guest console
// output or wrapper noise cannot corrupt the frame stream.
const channel = new net.Socket({ fd: 3, readable: true, writable: true });

let nextCallId = 1;
const pending = new Map<number, (reply: ConfinedHostReply) => void>();
let jobHandled = false;

channel.on('error', () => process.exit(1));

channel.on(
	'data',
	createFrameReader({
		maxFrameBytes: limits.parentToChildFrameMax,
		onFrame: handleFrame,
		onProtocolViolation: () => process.exit(1),
	})
);

function readLimits(): { parentToChildFrameMax: number; maxResultBytes: number } {
	const raw = process.env['CONFINED_SANDBOX_LIMITS'];

	if (raw === undefined || raw.trim() === '') {
		return failClosed('the confined child host was started without its sandbox limits');
	}

	let parsed: Record<string, unknown>;

	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return failClosed('the confined child host received malformed sandbox limits');
	}

	const parentToChildFrameMax = parsed['parentToChildFrameMax'];
	const maxResultBytes = parsed['maxResultBytes'];

	if (!isPositiveInt(parentToChildFrameMax) || !isPositiveInt(maxResultBytes)) {
		return failClosed('the confined child host received incomplete sandbox limits');
	}

	return { parentToChildFrameMax, maxResultBytes };
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function failClosed(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function handleFrame(message: unknown): void {
	const type = messageType(message);

	if (type === 'host-reply') {
		resolveHostReply(message);
		return;
	}

	// One job of either kind per child. A run job and a probe job take distinct
	// paths to distinct replies, so the contracts never blend.
	if (type === 'job' || type === 'probe') {
		if (jobHandled) return;
		jobHandled = true;

		if (type === 'job') {
			if (isJobMessage(message)) {
				void handleJob(message);
			} else {
				send({ ok: false, error: { code: 'internal', message: 'the confined runtime received an invalid job' } });
			}

			return;
		}

		if (isProbeMessage(message)) {
			void handleProbe(message);
		} else {
			sendProbe({
				loadable: false,
				error: { code: 'internal', message: 'the confined runtime received an invalid probe' },
			});
		}
	}
}

function hostBridge(call: ConfinedHostCall): Promise<ConfinedHostReply> {
	const id = nextCallId++;

	return new Promise((resolve) => {
		pending.set(id, resolve);
		const message: ConfinedHostCallMessage = { type: 'host-call', id, method: call.method, args: call.args };
		writeFrame(channel, message, () => undefined);
	});
}

async function handleJob(message: ConfinedJobMessage): Promise<void> {
	let result: ConfinedResult;

	try {
		result = await runConfinedEntry(message.invocation, hostBridge);
	} catch {
		result = { ok: false, error: { code: 'internal', message: 'the confined runtime failed' } };
	}

	send(result);
}

async function handleProbe(message: ConfinedProbeJobMessage): Promise<void> {
	let result: ConfinedLoadProbeResult;

	try {
		result = await runConfinedLoadProbe(message.invocation);
	} catch {
		result = { loadable: false, error: { code: 'internal', message: 'the confined runtime failed' } };
	}

	sendProbe(result);
}

/**
 * Caps the result before framing. An oversized result fails as `invalid-result`, so
 * the parent reader never receives an over-cap frame it would reject as a crash. The
 * write drains before exit so the frame is not truncated.
 */
function send(result: ConfinedResult): void {
	let payload = result;

	if (result.ok && Buffer.byteLength(JSON.stringify(result.value), 'utf8') > limits.maxResultBytes) {
		payload = { ok: false, error: { code: 'invalid-result', message: 'the operation result is too large' } };
	}

	const done: ConfinedDoneMessage = { type: 'done', result: payload };
	writeFrame(channel, done, () => process.exit(0));
}

/** The probe verdict is a small fixed shape built child-side, so no result cap applies. */
function sendProbe(result: ConfinedLoadProbeResult): void {
	const done: ConfinedProbeDoneMessage = { type: 'probe-done', result };
	writeFrame(channel, done, () => process.exit(0));
}

function messageType(message: unknown): string | undefined {
	if (message === null || typeof message !== 'object') return undefined;
	const type = (message as { type?: unknown }).type;
	return typeof type === 'string' ? type : undefined;
}

function resolveHostReply(message: unknown): void {
	const record = message as { id?: unknown; reply?: unknown };
	if (typeof record.id !== 'number') return;

	const resolve = pending.get(record.id);
	if (resolve === undefined) return;

	pending.delete(record.id);
	resolve(isHostReply(record.reply) ? record.reply : malformedReply());
}

function malformedReply(): ConfinedHostReply {
	return { ok: false, error: { code: 'internal', message: 'malformed host reply' } };
}

function isHostReply(reply: unknown): reply is ConfinedHostReply {
	if (reply === null || typeof reply !== 'object') return false;
	const record = reply as { ok?: unknown; value?: unknown; error?: unknown };

	if (record.ok === true) return 'value' in record;

	if (record.ok === false) {
		if (record.error === null || typeof record.error !== 'object') return false;
		const error = record.error as { code?: unknown; message?: unknown };
		return typeof error.code === 'string' && typeof error.message === 'string';
	}

	return false;
}

function isJobMessage(message: unknown): message is ConfinedJobMessage {
	if (message === null || typeof message !== 'object') return false;
	const record = message as { type?: unknown; invocation?: unknown };
	return record.type === 'job' && record.invocation !== null && typeof record.invocation === 'object';
}

function isProbeMessage(message: unknown): message is ConfinedProbeJobMessage {
	if (message === null || typeof message !== 'object') return false;
	const record = message as { type?: unknown; invocation?: unknown };
	return record.type === 'probe' && record.invocation !== null && typeof record.invocation === 'object';
}
