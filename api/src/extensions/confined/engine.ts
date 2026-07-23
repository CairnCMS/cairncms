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

	return interpretGuestOutput(outcome.data, guestContract(invocation).noun);
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

	const noun = invocation.bundleEntries !== undefined ? 'confined bundle' : guestContract(invocation).noun;

	return interpretLoadProbeOutput(outcome.data, noun);
}

/**
 * The guest contract an invocation selects: the global the built entry must
 * expose, the activation type the context carries, and the noun for messages.
 */
function guestContract(invocation: ConfinedInvocation): {
	globalName: string;
	activation: NonNullable<ConfinedInvocation['activation']>;
	noun: string;
} {
	if (invocation.activation === 'json-endpoint') {
		return { globalName: 'CairnEndpoint', activation: 'json-endpoint', noun: 'json endpoint' };
	}

	if (invocation.activation === 'event-filter' || invocation.activation === 'event-action') {
		return { globalName: 'CairnHook', activation: invocation.activation, noun: 'event hook' };
	}

	return { globalName: 'CairnOperation', activation: 'flow-operation', noun: 'flow operation' };
}

function isEventActivation(invocation: ConfinedInvocation): boolean {
	return invocation.activation === 'event-filter' || invocation.activation === 'event-action';
}

/**
 * The JS that declares `__config`, the entry to run. A top-level entry comes from
 * its contract global's default export; a bundle entry is selected by `type:name`
 * from the artifact's CairnBundle record, through an own-property check so a
 * prototype-named key can never resolve to an inherited member.
 */
function configSelector(invocation: ConfinedInvocation): string {
	if (invocation.bundleEntryKey !== undefined) {
		const key = JSON.stringify(invocation.bundleEntryKey);

		return `const __cairnBundle =
				(typeof CairnBundle !== 'undefined' && CairnBundle.default)
					? CairnBundle.default
					: (typeof CairnBundle !== 'undefined' ? CairnBundle : undefined);
			const __config =
				(__cairnBundle !== null && typeof __cairnBundle === 'object' &&
					Object.prototype.hasOwnProperty.call(__cairnBundle, ${key}))
					? __cairnBundle[${key}]
					: undefined;`;
	}

	const global = guestContract(invocation).globalName;

	return `const __config =
			(typeof ${global} !== 'undefined' && ${global}.default)
				? ${global}.default
				: (typeof ${global} !== 'undefined' ? ${global} : undefined);`;
}

function buildHarness(invocation: ConfinedInvocation): string {
	if (isEventActivation(invocation)) return buildHookHarness(invocation);

	const contract = guestContract(invocation);
	const accountability = JSON.stringify(invocation.accountability ?? null);
	const extensionId = JSON.stringify(invocation.extensionId);
	const contributionId = JSON.stringify(invocation.contributionId);

	// An operation handler receives `{ options, input }`, a json endpoint handler
	// receives the shaped request carried in `input`.
	const payload =
		contract.activation === 'json-endpoint'
			? JSON.stringify(invocation.input)
			: `{ options: ${JSON.stringify(invocation.options)}, input: ${JSON.stringify(invocation.input)} }`;

	return `
		${invocation.entrySource}
		${configSelector(invocation)}
		if (!__config || typeof __config.handler !== 'function') {
			throw new Error('entry default export is not a ${contract.noun} config with a function handler');
		}
		${GUEST_HOST_SURFACE}
		const __context = {
			extensionId: ${extensionId},
			contributionId: ${contributionId},
			activation: { type: ${JSON.stringify(contract.activation)} },
			accountability: ${accountability},
			host,
		};
		const __payload = ${payload};
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

// The guest host surface, shared verbatim by every run harness so the contracts
// cannot drift apart.
const GUEST_HOST_SURFACE = `const host = {
			log: {
				debug: async (message, meta) => { await __hostCall('log.debug', { message, meta }); },
				info: async (message, meta) => { await __hostCall('log.info', { message, meta }); },
				warn: async (message, meta) => { await __hostCall('log.warn', { message, meta }); },
				error: async (message, meta) => { await __hostCall('log.error', { message, meta }); },
			},
			request: { send: (request) => __hostCall('request.send', request) },
			items: (() => {
				const readMany = (collection, query) => __hostCall('items.readMany', { collection, query });
				return {
					readMany,
					read: readMany,
					readOne: (collection, key, query) => __hostCall('items.readOne', { collection, key, query }),
				};
			})(),
			settings: { get: (key) => __hostCall('settings.get', { key }) },
			template: {
				renderLiquid: (template, data, options) => __hostCall('template.renderLiquid', { template, data, options }),
			},
		};`;

/**
 * The run harness for the event hook contract. The handler is selected from the
 * entry's own declared record by exact event name, and a filter result is wrapped
 * in an explicit envelope: `{ unchanged: true }` when the handler returned
 * undefined, `{ unchanged: false, payload }` otherwise, so JSON transport cannot
 * blur no-change with a missing reply.
 */
function buildHookHarness(invocation: ConfinedInvocation): string {
	const accountability = JSON.stringify(invocation.accountability ?? null);
	const extensionId = JSON.stringify(invocation.extensionId);
	const contributionId = JSON.stringify(invocation.contributionId);
	const input = JSON.stringify(invocation.input);
	const isFilter = invocation.activation === 'event-filter';
	const record = isFilter ? 'filters' : 'actions';

	return `
		${invocation.entrySource}
		${configSelector(invocation)}
		if (!__config || typeof __config.id !== 'string') {
			throw new Error('entry default export is not an event hook config');
		}
		${GUEST_HOST_SURFACE}
		const __input = ${input};
		const __context = {
			extensionId: ${extensionId},
			contributionId: ${contributionId},
			activation: { type: ${JSON.stringify(invocation.activation)}, event: __input.event },
			accountability: ${accountability},
			host,
		};
		const __run = async () => {
			if (__config.id !== ${contributionId}) return { kind: 'identity-mismatch' };
			const __record = __config[${JSON.stringify(record)}];
			const __handler =
				__record && Object.prototype.hasOwnProperty.call(__record, __input.event)
					? __record[__input.event]
					: undefined;
			if (typeof __handler !== 'function') return { kind: 'guest-error' };
			let value;
			try {
				value = ${
					isFilter
						? 'await __handler(__input.payload, __input.meta, __context)'
						: 'await __handler(__input.meta, __context)'
				};
			} catch (error) {
				// The raw guest message can carry payload or secret values, so it is
				// dropped here, not surfaced to the host.
				return { kind: 'guest-error' };
			}
			const __envelope = ${
				isFilter
					? '(value === undefined ? { unchanged: true } : { unchanged: false, payload: value })'
					: '{ done: true }'
			};
			let serialized;
			try {
				serialized = JSON.stringify(__envelope);
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
 * shape and identity, and stops there. It must never invoke a handler, only
 * type-check it, so probing an entry can have no handler side effect. The event
 * hook arm additionally requires the entry's declared handler sets to equal the
 * manifest's declared events, carried in the probe input, so the entry cannot
 * drift from the declaration the operator reviewed.
 */
function buildLoadProbeHarness(invocation: ConfinedInvocation): string {
	if (invocation.bundleEntries !== undefined) return buildBundleProbeHarness(invocation);
	if (isEventActivation(invocation)) return buildHookProbeHarness(invocation);

	const contract = guestContract(invocation);
	const contributionId = JSON.stringify(invocation.contributionId);

	return `
		${invocation.entrySource}
		const __config =
			(typeof ${contract.globalName} !== 'undefined' && ${contract.globalName}.default)
				? ${contract.globalName}.default
				: (typeof ${contract.globalName} !== 'undefined' ? ${contract.globalName} : undefined);
		const __verdict = () => {
			if (!__config || typeof __config.handler !== 'function') return { kind: 'invalid-entry' };
			if (__config.id !== ${contributionId}) return { kind: 'identity-mismatch' };
			return { kind: 'loadable' };
		};
		export default JSON.stringify(__verdict());
	`;
}

function buildHookProbeHarness(invocation: ConfinedInvocation): string {
	const contributionId = JSON.stringify(invocation.contributionId);
	const expected = JSON.stringify(invocation.input ?? { filters: [], actions: [] });

	return `
		${invocation.entrySource}
		const __config =
			(typeof CairnHook !== 'undefined' && CairnHook.default)
				? CairnHook.default
				: (typeof CairnHook !== 'undefined' ? CairnHook : undefined);
		const __expected = ${expected};
		const __declared = (record) => {
			if (record === undefined) return [];
			if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
			const names = Object.keys(record);
			for (const name of names) {
				if (typeof record[name] !== 'function') return null;
			}
			return names;
		};
		const __sameSet = (declared, expected) =>
			declared.length === expected.length && [...declared].sort().join('\\n') === [...expected].sort().join('\\n');
		const __verdict = () => {
			if (!__config || typeof __config.id !== 'string') return { kind: 'invalid-entry' };
			if (__config.id !== ${contributionId}) return { kind: 'identity-mismatch' };
			const filters = __declared(__config.filters);
			const actions = __declared(__config.actions);
			if (filters === null || actions === null) return { kind: 'invalid-entry' };
			if (!__sameSet(filters, __expected.filters) || !__sameSet(actions, __expected.actions)) {
				return { kind: 'declaration-mismatch' };
			}
			return { kind: 'loadable' };
		};
		export default JSON.stringify(__verdict());
	`;
}

/**
 * The bundle load-probe harness: evaluates the one bundle artifact and validates
 * every declared server entry against the CairnBundle record in a single pass, with
 * no handler invoked. Each entry must be present under its `type:name` key with a
 * config id equal to its name, an operation or endpoint entry must expose a handler
 * function, and a hook entry's declared handler sets must equal its manifest events.
 * Any one failing entry fails the whole bundle, since the artifact is shared.
 */
function buildBundleProbeHarness(invocation: ConfinedInvocation): string {
	const expected = JSON.stringify(invocation.bundleEntries ?? []);

	return `
		${invocation.entrySource}
		const __bundle =
			(typeof CairnBundle !== 'undefined' && CairnBundle.default)
				? CairnBundle.default
				: (typeof CairnBundle !== 'undefined' ? CairnBundle : undefined);
		const __expected = ${expected};
		const __own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
		const __declared = (record) => {
			if (record === undefined) return [];
			if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
			const names = Object.keys(record);
			for (const name of names) {
				if (typeof record[name] !== 'function') return null;
			}
			return names;
		};
		const __sameSet = (a, b) =>
			a.length === b.length && [...a].sort().join('\\n') === [...b].sort().join('\\n');
		const __verdict = () => {
			if (!__bundle || typeof __bundle !== 'object') return { kind: 'invalid-entry' };
			for (const entry of __expected) {
				const config = __own(__bundle, entry.key) ? __bundle[entry.key] : undefined;
				if (!config || typeof config !== 'object') return { kind: 'invalid-entry' };
				if (config.id !== entry.name) return { kind: 'identity-mismatch' };
				if (entry.kind === 'hook') {
					const filters = __declared(config.filters);
					const actions = __declared(config.actions);
					if (filters === null || actions === null) return { kind: 'invalid-entry' };
					if (!__sameSet(filters, entry.events.filters) || !__sameSet(actions, entry.events.actions)) {
						return { kind: 'declaration-mismatch' };
					}
				} else if (typeof config.handler !== 'function') {
					return { kind: 'invalid-entry' };
				}
			}
			return { kind: 'loadable' };
		};
		export default JSON.stringify(__verdict());
	`;
}

function interpretLoadProbeOutput(data: unknown, noun: string): ConfinedLoadProbeResult {
	const unreadable: ConfinedLoadProbeResult = {
		loadable: false,
		error: { code: 'invalid-entry', message: `the ${noun} entry could not be evaluated` },
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
			error: { code: 'identity-mismatch', message: `the ${noun} id does not match its contribution` },
		};
	}

	if (envelope.kind === 'declaration-mismatch') {
		return {
			loadable: false,
			error: { code: 'identity-mismatch', message: `the ${noun} entry does not declare the manifest events` },
		};
	}

	if (envelope.kind === 'invalid-entry') {
		return {
			loadable: false,
			error: { code: 'invalid-entry', message: `the entry is not a ${noun} config with a function handler` },
		};
	}

	return unreadable;
}

function interpretGuestOutput(data: unknown, noun: string): ConfinedResult {
	if (typeof data !== 'string') {
		return fail({ code: 'invalid-result', message: `the ${noun} produced an unreadable result` });
	}

	let envelope: { kind?: unknown; value?: unknown; message?: unknown };

	try {
		envelope = JSON.parse(data);
	} catch {
		return fail({ code: 'invalid-result', message: `the ${noun} produced an unreadable result` });
	}

	if (envelope.kind === 'ok') {
		try {
			return { ok: true, value: JSON.parse(String(envelope.value)) };
		} catch {
			return fail({ code: 'invalid-result', message: `the ${noun} result is not JSON-serializable` });
		}
	}

	if (envelope.kind === 'guest-error') {
		return fail({ code: 'guest-error', message: `the ${noun} failed` });
	}

	if (envelope.kind === 'identity-mismatch') {
		return fail({ code: 'identity-mismatch', message: `the ${noun} id does not match its contribution` });
	}

	if (envelope.kind === 'invalid-result') {
		return fail({ code: 'invalid-result', message: `the ${noun} result is not JSON-serializable` });
	}

	return fail({ code: 'internal', message: `the ${noun} produced an unexpected result` });
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
