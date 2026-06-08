import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify';
import { expose, loadAsyncQuickJs } from '@sebastianwessel/quickjs';
import { Scope } from 'quickjs-emscripten-core';
import type { ConfinedHostBridge, ConfinedInvocation, ConfinedResult, ConfinedRuntimeError } from './types.js';

type QuickJsRuntime = Awaited<ReturnType<typeof loadAsyncQuickJs>>;

let runtimePromise: Promise<QuickJsRuntime> | undefined;

// The variant package's default export is the async WASM variant at runtime, but
// its types resolve to the module namespace, so it is cast to the loader's param.
const asyncVariant = variant as unknown as Parameters<typeof loadAsyncQuickJs>[0];

export const unsupportedHostBridge: ConfinedHostBridge = async () => ({
	ok: false,
	error: { code: 'unsupported', message: 'host API is not available in this runtime' },
});

async function getRuntime(): Promise<QuickJsRuntime> {
	if (runtimePromise === undefined) runtimePromise = loadAsyncQuickJs(asyncVariant);
	return runtimePromise;
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
	let evaluated: { ok: true; data: unknown } | { ok: false; error: unknown };

	try {
		const { runSandboxed } = await getRuntime();

		evaluated = (await runSandboxed(
			async ({ ctx, evalCode }) => {
				const scope = new Scope();

				try {
					expose(ctx, scope, {
						__hostCall: (method: unknown, args: unknown) => hostBridge({ method: String(method), args }),
					});

					return await evalCode(buildHarness(invocation));
				} finally {
					scope.dispose();
				}
			},
			{
				allowFetch: false,
				allowFs: false,
				executionTimeout: invocation.limits.cpuTimeoutMs,
				memoryLimit: invocation.limits.memoryBytes,
				maxStackSize: invocation.limits.stackBytes,
			}
		)) as typeof evaluated;
	} catch (error) {
		return fail(classifyEvalError(error));
	}

	if (evaluated.ok !== true) {
		return fail(classifyEvalError(evaluated.error));
	}

	return interpretGuestOutput(evaluated.data);
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
