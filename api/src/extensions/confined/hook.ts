import type { Accountability, ExtensionCapabilities } from '@cairncms/types';
import {
	createConfinedHostBroker,
	DARK_SETTINGS,
	type ConfinedHostBrokerDeps,
	type ConfinedLogEntry,
} from './broker.js';
import { toConfinedAccountability } from './operation.js';
import { ConfinedSecretScope } from './secret-scope.js';
import type { ConfinedHostDispatcher, ConfinedInvocation, ConfinedResult, ConfinedRuntimeLimits } from './types.js';

export const HOOK_PAYLOAD_BYTES_MAX = 1024 * 1024;
export const HOOK_META_BYTES_MAX = 256 * 1024;

export interface ConfinedHookRequest {
	extensionId: string;
	// The hook contribution id, which is also the entry's declared identity.
	contributionId: string;
	// The gate-probed built server entry bytes. Executed as bytes, never imported.
	entrySource: string;
	// When the entry is one server entry of a bundle artifact, its `type:name` key.
	bundleEntryKey?: string;
	capabilities: ExtensionCapabilities;
	// The exact platform event that fired.
	event: string;
	meta: Record<string, unknown>;
	accountability: Accountability | null;
}

export interface ConfinedFilterHookRequest extends ConfinedHookRequest {
	payload: unknown;
}

export interface ConfinedHookDeps {
	// The supervisor run seam: spawns the child and brokers its host calls.
	invoke: (invocation: ConfinedInvocation, dispatcher: ConfinedHostDispatcher) => Promise<ConfinedResult>;
	// The platform log sink. The broker redacts before this is called.
	log: (entry: ConfinedLogEntry) => void;
	getAxios?: ConfinedHostBrokerDeps['getAxios'];
	itemsService?: ConfinedHostBrokerDeps['itemsService'];
	brokerLimits: ConfinedHostBrokerDeps['limits'];
	runtimeLimits: ConfinedRuntimeLimits;
}

/**
 * The filter verdict. `unchanged` carries the guest's explicit no-change envelope
 * through, so the binding can keep the platform's undefined-means-no-change
 * semantics. A failure carries no guest detail; the binding decides what a
 * failure does (a filter blocks, an action logs).
 */
export type ConfinedFilterHookResult =
	| { ok: true; unchanged: true }
	| { ok: true; unchanged: false; payload: unknown }
	| { ok: false };

export type ConfinedActionHookResult = { ok: boolean };

function withinBytes(value: unknown, cap: number): boolean {
	let serialized: string;

	try {
		serialized = JSON.stringify(value) ?? 'null';
	} catch {
		return false;
	}

	return Buffer.byteLength(serialized, 'utf8') <= cap;
}

function buildInvocation(
	request: ConfinedHookRequest,
	activation: 'event-filter' | 'event-action',
	input: Record<string, unknown>,
	limits: ConfinedRuntimeLimits
): ConfinedInvocation {
	const invocation: ConfinedInvocation = {
		extensionId: request.extensionId,
		contributionId: request.contributionId,
		operationId: request.contributionId,
		activation,
		entrySource: request.entrySource,
		options: {},
		input,
		accountability: toConfinedAccountability(request.accountability),
		limits,
	};

	if (request.bundleEntryKey !== undefined) invocation.bundleEntryKey = request.bundleEntryKey;

	return invocation;
}

function buildDispatcher(request: ConfinedHookRequest, deps: ConfinedHookDeps): ConfinedHostDispatcher {
	const brokerDeps: ConfinedHostBrokerDeps = {
		capabilities: request.capabilities,
		log: deps.log,
		settings: DARK_SETTINGS,
		accountability: request.accountability,
		limits: deps.brokerLimits,
		// Hooks mint no option handles, so no reference ever resolves.
		resolveSecret: async () => null,
	};

	if (deps.getAxios !== undefined) brokerDeps.getAxios = deps.getAxios;
	if (deps.itemsService !== undefined) brokerDeps.itemsService = deps.itemsService;

	return createConfinedHostBroker(brokerDeps, new ConfinedSecretScope());
}

/**
 * Runs a confined filter hook for one event firing. The payload and meta are
 * measured before the parent materializes a child frame, the guest receives the
 * inherited-style `(payload, meta, context)` shape, and the reply is held to the
 * explicit envelope: `{ unchanged: true }` or `{ unchanged: false, payload }`.
 * Every failure is `{ ok: false }` with no guest detail; the binding blocks the
 * platform action on it, because a filter that cannot run must not be skipped.
 */
export async function runConfinedFilterHook(
	request: ConfinedFilterHookRequest,
	deps: ConfinedHookDeps
): Promise<ConfinedFilterHookResult> {
	if (!withinBytes(request.payload, HOOK_PAYLOAD_BYTES_MAX)) return { ok: false };
	if (!withinBytes(request.meta, HOOK_META_BYTES_MAX)) return { ok: false };

	try {
		const invocation = buildInvocation(
			request,
			'event-filter',
			{ event: request.event, payload: request.payload, meta: request.meta },
			deps.runtimeLimits
		);

		const result = await deps.invoke(invocation, buildDispatcher(request, deps));

		if (!result.ok) return { ok: false };

		const envelope = result.value;
		if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return { ok: false };

		for (const key of Object.keys(envelope)) {
			if (key !== 'unchanged' && key !== 'payload') return { ok: false };
		}

		const record = envelope as { unchanged?: unknown; payload?: unknown };

		if (record.unchanged === true) return { ok: true, unchanged: true };
		if (record.unchanged === false) return { ok: true, unchanged: false, payload: record.payload ?? null };

		return { ok: false };
	} catch {
		return { ok: false };
	}
}

/**
 * Runs a confined action hook for one event firing. Bounded and shaped the same
 * way, with the completion-only envelope. The binding logs a failure and never
 * blocks the platform action that already happened.
 */
export async function runConfinedActionHook(
	request: ConfinedHookRequest,
	deps: ConfinedHookDeps
): Promise<ConfinedActionHookResult> {
	if (!withinBytes(request.meta, HOOK_META_BYTES_MAX)) return { ok: false };

	try {
		const invocation = buildInvocation(
			request,
			'event-action',
			{ event: request.event, meta: request.meta },
			deps.runtimeLimits
		);

		const result = await deps.invoke(invocation, buildDispatcher(request, deps));

		if (!result.ok) return { ok: false };

		const envelope = result.value as { done?: unknown } | null;
		return { ok: envelope !== null && typeof envelope === 'object' && envelope.done === true };
	} catch {
		return { ok: false };
	}
}
