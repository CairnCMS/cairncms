import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify';
import { expose, loadAsyncQuickJs } from '@sebastianwessel/quickjs';
import { newVariant, Scope } from 'quickjs-emscripten-core';
import type {
	ConfinedHostBridge,
	ConfinedInvocation,
	ConfinedLoadProbeResult,
	ConfinedResult,
	ConfinedRuntimeError,
} from './types.js';

type QuickJsRuntime = Awaited<ReturnType<typeof loadAsyncQuickJs>>;

let runtimePromise: Promise<QuickJsRuntime> | undefined;
let runtimeMemoryBytes: number | undefined;

// The variant package's default export is the async WASM variant at runtime, but
// its types resolve to the module namespace, so it is cast to the loader's param.
const asyncVariant = variant as unknown as Parameters<typeof loadAsyncQuickJs>[0];

const WASM_PAGE_BYTES = 64 * 1024;

// The module's default initial linear memory (16 MB), kept so the engine loads.
export const WASM_INITIAL_PAGES = 256;

// The engine's own linear-memory working set plus headroom, on top of the guest heap.
const WASM_OVERHEAD_BYTES = 32 * 1024 * 1024;

/**
 * The WASM linear-memory maximum in 64 KB pages: the guest heap plus the engine working set
 * and headroom, never below the initial size so the module can still load.
 */
export function wasmMaximumPages(memoryBytes: number): number {
	const sized = Math.ceil((memoryBytes + WASM_OVERHEAD_BYTES) / WASM_PAGE_BYTES);
	return Math.max(sized, WASM_INITIAL_PAGES);
}

/**
 * The QuickJS memoryLimit accounts strings and objects but not array or typed-array backing
 * stores, which otherwise grow the WASM linear memory to its ~2 GB default maximum. Capping
 * the maximum bounds every allocation kind, so the linear-memory ceiling, not the QuickJS
 * limit, is the real per-guest memory bound.
 */
function sizedVariant(memoryBytes: number): Parameters<typeof loadAsyncQuickJs>[0] {
	const wasmMemory = new WebAssembly.Memory({ initial: WASM_INITIAL_PAGES, maximum: wasmMaximumPages(memoryBytes) });
	return newVariant(asyncVariant as Parameters<typeof newVariant>[0], { wasmMemory }) as Parameters<
		typeof loadAsyncQuickJs
	>[0];
}

export const unsupportedHostBridge: ConfinedHostBridge = async () => ({
	ok: false,
	error: { code: 'unsupported', message: 'host API is not available in this runtime' },
});

// The cap on concurrent guest timers, an explicit bound against timer flooding rather
// than the wrapper's implicit default.
export const MAX_GUEST_TIMERS = 256;

// Every guest console method is dropped, so guest output never reaches the host stream
// rather than relying on the spawned child's stdout being discarded.
const silencedConsole = Object.fromEntries(
	[
		'log',
		'info',
		'warn',
		'error',
		'debug',
		'trace',
		'assert',
		'count',
		'countReset',
		'dir',
		'dirxml',
		'group',
		'groupCollapsed',
		'groupEnd',
		'table',
		'time',
		'timeEnd',
		'timeLog',
		'clear',
	].map((name) => [name, () => undefined])
) as Record<string, () => void>;

// The static engine-hardening options, separate from the per-invocation resource limits.
// `dangerousSync` is deliberately absent: setting it would expose synchronous host
// functions to the guest. its absence is asserted by the tests.
export const hardenedSandboxOptions = {
	allowFetch: false,
	allowFs: false,
	console: silencedConsole,
	maxTimeoutCount: MAX_GUEST_TIMERS,
	maxIntervalCount: MAX_GUEST_TIMERS,
};

/**
 * Loads the QuickJS runtime, sizing the WASM linear-memory ceiling from the job's memory
 * limit. The supervisor spawns one child per invocation, so in production this resolves
 * once. The runtime is keyed by memory limit and rebuilt when the limit changes, so the
 * ceiling always reflects the current job's limit rather than inheriting an earlier job's
 * size. The memory bound is therefore self-contained here, not dependent on the single-use
 * guard in another module.
 */
async function getRuntime(memoryBytes: number): Promise<QuickJsRuntime> {
	if (runtimePromise === undefined || memoryBytes !== runtimeMemoryBytes) {
		runtimeMemoryBytes = memoryBytes;
		runtimePromise = loadAsyncQuickJs(sizedVariant(memoryBytes));
	}

	return runtimePromise;
}

type HarnessOutcome = { kind: 'evaluated'; data: unknown } | { kind: 'error'; error: ConfinedRuntimeError };

/**
 * Evaluates a harness in QuickJS under the invocation's limits with `__hostCall`
 * exposed over the given bridge. The shared internal of the run and probe paths:
 * it owns the engine setup and the eval-error classification, and nothing else,
 * so the two contracts never blend.
 */
async function runConfinedHarness(
	invocation: ConfinedInvocation,
	hostBridge: ConfinedHostBridge,
	harnessSource: string
): Promise<HarnessOutcome> {
	let evaluated: { ok: true; data: unknown } | { ok: false; error: unknown };

	try {
		const { runSandboxed } = await getRuntime(invocation.limits.memoryBytes);

		evaluated = (await runSandboxed(
			async ({ ctx, evalCode }) => {
				const scope = new Scope();

				try {
					expose(ctx, scope, {
						__hostCall: (method: unknown, args: unknown) => hostBridge({ method: String(method), args }),
					});

					return await evalCode(harnessSource);
				} finally {
					scope.dispose();
				}
			},
			{
				...hardenedSandboxOptions,
				executionTimeout: invocation.limits.cpuTimeoutMs,
				memoryLimit: invocation.limits.memoryBytes,
				maxStackSize: invocation.limits.stackBytes,
			}
		)) as typeof evaluated;
	} catch (error) {
		return { kind: 'error', error: classifyEvalError(error) };
	}

	if (evaluated.ok !== true) {
		return { kind: 'error', error: classifyEvalError(evaluated.error) };
	}

	return { kind: 'evaluated', data: evaluated.data };
}

/**
 * Evaluates a confined entry in QuickJS and returns a JSON-safe result. The entry
 * source must be an esbuild IIFE exposing globalName `CairnOperation` with
 * `{ default: { id, handler } }`. The engine grants no authority: fetch and fs are
 * off, no host env is passed, and the config id is checked against the contribution
 * id before invocation. The only host effect is the bridged `__hostCall`, so the
 * engine itself holds no privileged effect.
 */
export async function runConfinedEntry(
	invocation: ConfinedInvocation,
	hostBridge: ConfinedHostBridge
): Promise<ConfinedResult> {
	const outcome = await runConfinedHarness(invocation, hostBridge, buildHarness(invocation));

	if (outcome.kind === 'error') return fail(outcome.error);

	return interpretGuestOutput(outcome.data);
}

/**
 * Evaluates a confined entry to a load verdict without ever invoking its handler.
 * The probe environment matches the run path minus the handler call: the same
 * engine options and the same `__hostCall` exposure, answered deny-all, so
 * module-level code sees the surface it would see at run and the verdict is
 * honest for the path it certifies.
 */
export async function runConfinedLoadProbe(invocation: ConfinedInvocation): Promise<ConfinedLoadProbeResult> {
	const outcome = await runConfinedHarness(invocation, unsupportedHostBridge, buildLoadProbeHarness(invocation));

	if (outcome.kind === 'error') return { loadable: false, error: outcome.error };

	return interpretLoadProbeOutput(outcome.data);
}

function buildHarness(invocation: ConfinedInvocation): string {
	const options = JSON.stringify(invocation.options);
	const input = JSON.stringify(invocation.input);
	const accountability = JSON.stringify(invocation.accountability ?? null);
	const extensionId = JSON.stringify(invocation.extensionId);
	const contributionId = JSON.stringify(invocation.contributionId);

	return `
		${invocation.entrySource}
		const __config =
			(typeof CairnOperation !== 'undefined' && CairnOperation.default)
				? CairnOperation.default
				: (typeof CairnOperation !== 'undefined' ? CairnOperation : undefined);
		if (!__config || typeof __config.handler !== 'function') {
			throw new Error('entry default export is not a flow operation config with a function handler');
		}
		const host = {
			log: {
				debug: async (message, meta) => { await __hostCall('log.debug', { message, meta }); },
				info: async (message, meta) => { await __hostCall('log.info', { message, meta }); },
				warn: async (message, meta) => { await __hostCall('log.warn', { message, meta }); },
				error: async (message, meta) => { await __hostCall('log.error', { message, meta }); },
			},
			request: { send: (request) => __hostCall('request.send', request) },
			items: {
				read: (collection, query) => __hostCall('items.read', { collection, query }),
				readOne: (collection, key, query) => __hostCall('items.readOne', { collection, key, query }),
			},
			settings: { get: (key) => __hostCall('settings.get', { key }) },
			template: {
				renderLiquid: (template, data, options) => __hostCall('template.renderLiquid', { template, data, options }),
			},
		};
		const __context = {
			extensionId: ${extensionId},
			contributionId: ${contributionId},
			activation: { type: 'flow-operation' },
			accountability: ${accountability},
			host,
		};
		const __payload = { options: ${options}, input: ${input} };
		const __run = async () => {
			if (__config.id !== ${contributionId}) return { kind: 'identity-mismatch' };
			let value;
			try {
				value = await __config.handler(__payload, __context);
			} catch (error) {
				// The raw guest message can carry options, input, or secret values, so
				// it is dropped here, not surfaced to the host.
				return { kind: 'guest-error' };
			}
			let serialized;
			try {
				serialized = JSON.stringify(value);
			} catch {
				return { kind: 'invalid-result' };
			}
			if (serialized === undefined) return { kind: 'invalid-result' };
			return { kind: 'ok', value: serialized };
		};
		export default JSON.stringify(await __run());
	`;
}

/**
 * The load-probe harness: evaluates the entry and validates the confined config
 * shape and identity, and stops there. It must never invoke the handler, only
 * type-check it, so probing an entry can have no handler side effect.
 */
function buildLoadProbeHarness(invocation: ConfinedInvocation): string {
	const contributionId = JSON.stringify(invocation.contributionId);

	return `
		${invocation.entrySource}
		const __config =
			(typeof CairnOperation !== 'undefined' && CairnOperation.default)
				? CairnOperation.default
				: (typeof CairnOperation !== 'undefined' ? CairnOperation : undefined);
		const __verdict = () => {
			if (!__config || typeof __config.handler !== 'function') return { kind: 'invalid-entry' };
			if (__config.id !== ${contributionId}) return { kind: 'identity-mismatch' };
			return { kind: 'loadable' };
		};
		export default JSON.stringify(__verdict());
	`;
}

function interpretLoadProbeOutput(data: unknown): ConfinedLoadProbeResult {
	const unreadable: ConfinedLoadProbeResult = {
		loadable: false,
		error: { code: 'invalid-entry', message: 'the operation entry could not be evaluated' },
	};

	if (typeof data !== 'string') return unreadable;

	let envelope: { kind?: unknown };

	try {
		envelope = JSON.parse(data);
	} catch {
		return unreadable;
	}

	if (envelope.kind === 'loadable') return { loadable: true };

	if (envelope.kind === 'identity-mismatch') {
		return {
			loadable: false,
			error: { code: 'identity-mismatch', message: 'the operation id does not match its contribution' },
		};
	}

	if (envelope.kind === 'invalid-entry') {
		return {
			loadable: false,
			error: { code: 'invalid-entry', message: 'the entry is not a flow operation config with a function handler' },
		};
	}

	return unreadable;
}

function interpretGuestOutput(data: unknown): ConfinedResult {
	if (typeof data !== 'string') {
		return fail({ code: 'invalid-result', message: 'the operation produced an unreadable result' });
	}

	let envelope: { kind?: unknown; value?: unknown; message?: unknown };

	try {
		envelope = JSON.parse(data);
	} catch {
		return fail({ code: 'invalid-result', message: 'the operation produced an unreadable result' });
	}

	if (envelope.kind === 'ok') {
		try {
			return { ok: true, value: JSON.parse(String(envelope.value)) };
		} catch {
			return fail({ code: 'invalid-result', message: 'the operation result is not JSON-serializable' });
		}
	}

	if (envelope.kind === 'guest-error') {
		return fail({ code: 'guest-error', message: 'the operation failed' });
	}

	if (envelope.kind === 'identity-mismatch') {
		return fail({ code: 'identity-mismatch', message: 'the operation id does not match its contribution' });
	}

	if (envelope.kind === 'invalid-result') {
		return fail({ code: 'invalid-result', message: 'the operation result is not JSON-serializable' });
	}

	return fail({ code: 'internal', message: 'the operation produced an unexpected result' });
}

/**
 * Classifies a QuickJS evaluation failure. Resource bounds map to a timeout,
 * anything else to an invalid entry. The raw error text is never surfaced to
 * callers.
 */
function classifyEvalError(error: unknown): ConfinedRuntimeError {
	const text = evalErrorText(error).toLowerCase();

	if (/interrupt|timeout|out of memory|memory limit|stack overflow|maximum call stack/.test(text)) {
		return { code: 'timeout', message: 'the operation exceeded its resource limits' };
	}

	return { code: 'invalid-entry', message: 'the operation entry could not be evaluated' };
}

function evalErrorText(error: unknown): string {
	if (error === null || error === undefined) return '';
	if (typeof error === 'string') return error;

	if (typeof error === 'object') {
		const record = error as Record<string, unknown>;
		const message = typeof record['message'] === 'string' ? record['message'] : '';
		const name = typeof record['name'] === 'string' ? record['name'] : '';
		return `${name} ${message}`;
	}

	return String(error);
}

function fail(error: ConfinedRuntimeError): ConfinedResult {
	return { ok: false, error };
}
