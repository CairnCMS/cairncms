import {
	API_EXTENSION_TYPES,
	CONFINED_RUNTIME,
	EXTENSION_PKG_KEY,
	ExtensionManifest,
	HYBRID_EXTENSION_TYPES,
} from '@cairncms/constants';
import type { ExtensionValidationReason, ExtensionValidationReasonCode } from '@cairncms/extensions';
import { scanCandidateSource } from '@cairncms/extensions/node';
import { readFileCapped } from '@cairncms/extensions/node/capped-read';
import { classifyEntryPath } from '@cairncms/extensions/node/entry-integrity';
import type {
	ConfinedHookEvents,
	ConfinedOptionDelivery,
	Extension,
	ExtensionCapabilities,
	ExtensionOptions,
} from '@cairncms/types';
import { isTypeIn } from '@cairncms/utils';
import path from 'node:path';
import type { SanitizedExtensionError } from '../../utils/sanitize-extension-error.js';
import { resolveSandboxConfig, type SandboxConfig } from './sandbox-limits.js';
import { getConfinedSupervisor } from './supervisor.js';
import type { ConfinedBundleProbeEntry, ConfinedInvocation, ConfinedLoadProbeResult } from './types.js';

// The manifest is a package.json, far below this on any real package.
export const MAX_MANIFEST_BYTES = 256 * 1024;

const GENERIC_DETAIL = 'confined validation failed';

// Gate-level, not a scanner reason: the gate could not complete (a host-side or
// scheduling failure), which says nothing about the extension. Refused fail-closed,
// but the remedy is revalidation, not a code change.
export const VALIDATION_INCOMPLETE = 'validation-incomplete';

// The probe codes that are honest not-loadable verdicts about the entry itself.
// Anything else from the probe is a gate-infrastructure failure.
const NOT_LOADABLE_CODES = new Set<string>(['invalid-entry', 'identity-mismatch', 'timeout', 'crash']);

// What a passing extension carries into the eligible set: the probed entry bytes
// for an operation, and the gate-validated capabilities. A top-level api or hybrid
// carries one capabilities object, a bundle carries a per-entry record keyed
// `type:name`, never merged, so one entry's grant cannot bleed into another's.
export type ConfinedEligibleEntry = {
	entrySource?: string;
	capabilities?: ExtensionCapabilities;
	entryCapabilities?: Record<string, ExtensionCapabilities>;
	// The exact event names declared per bundle hook entry, keyed `type:name`, the
	// declarations the bundle binding subscribes and the probe verifies the entry
	// against. A top-level hook carries its events in `events` instead.
	entryEvents?: Record<string, ConfinedHookEvents>;
	// The operation option keys the manifest declares as opaque references. The
	// binding mints a per-invocation handle for each and never sends its clear value
	// to the guest. Top-level operations only: the schema rejects optionDelivery on a
	// bundle operation entry, so a secret-bearing operation stays a top-level one.
	optionDelivery?: ConfinedOptionDelivery;
	// The exact event names a confined hook subscribes to, from the manifest, the
	// declaration the probe verified the entry against.
	events?: ConfinedHookEvents;
};

export type ConfinedGateVerdict =
	| ({ ok: true } & ConfinedEligibleEntry)
	| { ok: false; error: SanitizedExtensionError };

export interface ConfinedLoadGateDeps {
	scan?: typeof scanCandidateSource;
	readFile?: typeof readFileCapped;
	probe?: (invocation: ConfinedInvocation) => Promise<ConfinedLoadProbeResult>;
	config?: SandboxConfig;
}

/**
 * Converts a validation reason into the loader's sanitized error shape. The detail
 * may carry a relative in-package path, but anything that could reference a
 * location outside the package (an absolute path or a traversal) collapses to a
 * generic message rather than reach diagnostics.
 */
export function confinedValidationError(reason: ExtensionValidationReason): SanitizedExtensionError {
	return { code: reason.code, detail: safeDetail(reason.message) };
}

function safeDetail(message: string | undefined): string {
	if (message === undefined || message.length === 0) return GENERIC_DETAIL;

	const unsafe = message.split(/\s+/).some((token) => path.isAbsolute(token) || token.includes('..'));

	return unsafe ? GENERIC_DETAIL : message;
}

function refuse(code: ExtensionValidationReasonCode | string, detail: string): ConfinedGateVerdict {
	return { ok: false, error: { code, detail } };
}

/**
 * Compares the re-read manifest against the discovered identity: name, type, the
 * entrypoint, and for a bundle its entry set. The gate's verdict must describe
 * the extension that was discovered, so a manifest that changed shape since
 * discovery is refused rather than gated as a different extension.
 */
function matchesDiscovered(extension: Extension, manifestName: string, options: ExtensionOptions): boolean {
	if (manifestName !== extension.name || options.type !== extension.type) return false;

	if (isTypeIn(extension, API_EXTENSION_TYPES) && isTypeIn(options, API_EXTENSION_TYPES)) {
		return options.path === extension.entrypoint;
	}

	if (isTypeIn(extension, HYBRID_EXTENSION_TYPES) && isTypeIn(options, HYBRID_EXTENSION_TYPES)) {
		return options.path.app === extension.entrypoint.app && options.path.api === extension.entrypoint.api;
	}

	if (extension.type === 'bundle' && options.type === 'bundle') {
		if (options.path.app !== extension.entrypoint.app || options.path.api !== extension.entrypoint.api) return false;
		if (options.entries.length !== extension.entries.length) return false;

		return options.entries.every(
			(entry, index) => entry.type === extension.entries[index]?.type && entry.name === extension.entries[index]?.name
		);
	}

	return false;
}

/**
 * Collects the gate-validated capabilities per contribution. A top-level api or
 * hybrid contributes one object, a bundle contributes a record keyed `type:name`
 * over its server entries. Returns null when a bundle declares duplicate
 * server-entry keys, because a keyed record would silently overwrite one entry's
 * capabilities with another's and the binding identity would be ambiguous.
 */
function collectCapabilities(options: ExtensionOptions): ConfinedEligibleEntry | null {
	if (isTypeIn(options, API_EXTENSION_TYPES) || isTypeIn(options, HYBRID_EXTENSION_TYPES)) {
		const entry: ConfinedEligibleEntry = {};
		if (options.capabilities !== undefined) entry.capabilities = options.capabilities;

		if (isTypeIn(options, HYBRID_EXTENSION_TYPES) && options.optionDelivery !== undefined) {
			entry.optionDelivery = options.optionDelivery;
		}

		if (options.type === 'hook' && options.events !== undefined) {
			entry.events = options.events;
		}

		return entry;
	}

	if (options.type === 'bundle') {
		const seen = new Set<string>();
		const entryCapabilities: Record<string, ExtensionCapabilities> = {};
		const entryEvents: Record<string, ConfinedHookEvents> = {};
		const collected: ConfinedEligibleEntry = {};

		for (const entry of options.entries) {
			if (!isTypeIn(entry, API_EXTENSION_TYPES) && !isTypeIn(entry, HYBRID_EXTENSION_TYPES)) continue;

			const key = `${entry.type}:${entry.name}`;

			if (seen.has(key)) return null;
			seen.add(key);

			if (entry.capabilities !== undefined) {
				entryCapabilities[key] = entry.capabilities;
				collected.entryCapabilities = entryCapabilities;
			}

			if (entry.type === 'hook' && entry.events !== undefined) {
				entryEvents[key] = entry.events;
				collected.entryEvents = entryEvents;
			}
		}

		return collected;
	}

	return {};
}

/**
 * Resolves the server-side source entries the static scanner reads. App source is
 * browser code the lexer would false-positive on, so a hybrid contributes only its
 * `source.api` and a bundle only its server-type entries' source. Returns null for
 * a shape that cannot carry a confined server declaration.
 */
function serverSourceEntries(options: ExtensionOptions): string[] | null {
	if (isTypeIn(options, API_EXTENSION_TYPES)) return [options.source];
	if (isTypeIn(options, HYBRID_EXTENSION_TYPES)) return [options.source.api];

	if (options.type === 'bundle') {
		const entries: string[] = [];

		for (const entry of options.entries) {
			if (isTypeIn(entry, API_EXTENSION_TYPES)) entries.push(entry.source);
			else if (isTypeIn(entry, HYBRID_EXTENSION_TYPES)) entries.push(entry.source.api);
		}

		return entries;
	}

	return null;
}

/**
 * The static confined load gate. Re-reads the extension's manifest under a capped
 * read (the discovered model does not carry the declared source), resolves the
 * server-side source set, and runs the source scanner. Returns eligible or a
 * refusal with a sanitized reason. Fail-closed: any unreadable, oversized,
 * malformed, or contradictory input refuses.
 */
export async function gateConfinedExtension(
	extension: Extension,
	deps: ConfinedLoadGateDeps = {}
): Promise<ConfinedGateVerdict> {
	const readFile = deps.readFile ?? readFileCapped;
	const scan = deps.scan ?? scanCandidateSource;

	const manifestRead = await readFile(path.join(extension.path, 'package.json'), MAX_MANIFEST_BYTES);

	if (!manifestRead.ok) {
		return manifestRead.reason === 'too-large'
			? refuse('manifest-too-large', 'the extension manifest exceeds the size cap')
			: refuse('manifest-invalid', 'the extension manifest could not be read');
	}

	let manifestJson: unknown;

	try {
		manifestJson = JSON.parse(manifestRead.text);
	} catch {
		return refuse('manifest-invalid', 'the extension manifest is not valid JSON');
	}

	const manifest = ExtensionManifest.safeParse(manifestJson);

	if (!manifest.success) {
		return refuse('manifest-invalid', 'the extension manifest failed validation');
	}

	const options = manifest.data[EXTENSION_PKG_KEY];

	// The manifest can change between discovery and the gate, so the confined
	// declaration and the discovered identity are re-checked against the bytes
	// just read, not trusted from the discovered model.
	if (options.runtime !== CONFINED_RUNTIME) {
		return refuse('manifest-invalid', 'the extension manifest does not declare a confined runtime');
	}

	if (!matchesDiscovered(extension, manifest.data.name, options)) {
		return refuse('manifest-invalid', 'the extension manifest does not match the discovered extension');
	}

	const collected = collectCapabilities(options);

	if (collected === null) {
		return refuse('manifest-invalid', 'the extension manifest declares duplicate server entries');
	}

	const entries = serverSourceEntries(options);

	if (entries === null) {
		return refuse('manifest-invalid', 'the confined declaration is not valid for this extension type');
	}

	const { reasons } = await scan({ root: extension.path, entries });
	const reason = reasons[0];

	if (reason !== undefined) {
		return { ok: false, error: confinedValidationError(reason) };
	}

	// The eval probe certifies every contract that has a binding: flow operations,
	// json endpoints, event hooks, and bundles. A bundle probes its one shared
	// artifact against all declared server entries at once, so a single bad entry
	// fails the whole server side.
	if (isTypeIn(options, HYBRID_EXTENSION_TYPES)) {
		const probed = await probeServerEntry(extension, options.path.api, deps, { activation: 'flow-operation' });
		if (!probed.ok) return probed;

		return { ...probed, ...collected };
	}

	if (options.type === 'endpoint') {
		const probed = await probeServerEntry(extension, options.path, deps, { activation: 'json-endpoint' });
		if (!probed.ok) return probed;

		return { ...probed, ...collected };
	}

	if (options.type === 'hook') {
		if (options.events === undefined) {
			return refuse('manifest-invalid', 'a confined hook must declare its events in the manifest');
		}

		// The probe verifies the entry's declared handler sets equal the manifest
		// declaration, so the reviewed subscription surface is the real one.
		const expected = { filters: options.events.filter ?? [], actions: options.events.action ?? [] };

		const probed = await probeServerEntry(extension, options.path, deps, {
			activation: 'event-filter',
			input: expected,
		});

		if (!probed.ok) return probed;

		return { ...probed, ...collected };
	}

	if (options.type === 'bundle') {
		// Each declared server entry, keyed `type:name`, with the config id it must
		// carry and, for a hook, the manifest events its handler sets must equal.
		const bundleEntries: ConfinedBundleProbeEntry[] = [];

		for (const entry of options.entries) {
			if (entry.type === 'endpoint') {
				bundleEntries.push({ key: `endpoint:${entry.name}`, name: entry.name, kind: 'endpoint' });
			} else if (entry.type === 'hook') {
				// Defense in depth past the schema: a hook entry without events would
				// probe inert, so it fails closed here too.
				if (entry.events === undefined) {
					return refuse('manifest-invalid', 'a hook entry in a bundle must declare its events');
				}

				bundleEntries.push({
					key: `hook:${entry.name}`,
					name: entry.name,
					kind: 'hook',
					events: { filters: entry.events.filter ?? [], actions: entry.events.action ?? [] },
				});
			} else if (isTypeIn(entry, HYBRID_EXTENSION_TYPES)) {
				bundleEntries.push({ key: `operation:${entry.name}`, name: entry.name, kind: 'operation' });
			}
		}

		const probed = await probeServerEntry(extension, options.path.api, deps, { bundleEntries });
		if (!probed.ok) return probed;

		return { ...probed, ...collected };
	}

	return { ok: true, ...collected };
}

/**
 * The dynamic half of the gate: reads the built server entry under path
 * containment and the artifact cap, evaluates it in the confined child through the
 * load probe under the given activation's contract, and classifies the outcome. A
 * not-loadable verdict refuses with the probe's code. A host-side failure refuses
 * `validation-incomplete`, never blaming the extension for the gate's own failure.
 * On success the probed bytes are returned, so the binding executes exactly what
 * was scanned and probed.
 */
async function probeServerEntry(
	extension: Extension,
	entryRelative: string,
	deps: ConfinedLoadGateDeps,
	shape: { activation?: ConfinedInvocation['activation']; input?: unknown; bundleEntries?: ConfinedBundleProbeEntry[] }
): Promise<ConfinedGateVerdict> {
	const readFile = deps.readFile ?? readFileCapped;
	const probe = deps.probe ?? ((invocation: ConfinedInvocation) => getConfinedSupervisor().probeLoad(invocation));

	let config = deps.config;

	if (config === undefined) {
		const resolved = resolveSandboxConfig();

		if (!resolved.ok) {
			return refuse(VALIDATION_INCOMPLETE, 'the sandbox configuration could not be resolved');
		}

		config = resolved.config;
	}

	const classified = await classifyEntryPath(extension.path, entryRelative);

	if (classified.kind === 'escapes-root') {
		return refuse('local-path-escapes-root', 'the built server entry escapes the package root');
	}

	if (classified.kind === 'unresolved') {
		return refuse('source-unavailable', 'the built server entry was not found');
	}

	const entryRead = await readFile(classified.real, config.sandbox.maxArtifactBytes);

	if (!entryRead.ok) {
		return entryRead.reason === 'too-large'
			? refuse('artifact-too-large', 'the built server entry exceeds the artifact cap')
			: refuse('source-read-failed', 'the built server entry could not be read');
	}

	// The probe runs under the operator's resolved runtime maxima, not the built-in
	// defaults: the supervisor clamps stricter-never-looser, so probing below an
	// operator-raised cap would falsely refuse an entry the operator sized for.
	const invocation: ConfinedInvocation = {
		extensionId: extension.name,
		contributionId: extension.name,
		operationId: extension.name,
		entrySource: entryRead.text,
		options: {},
		input: shape.input ?? null,
		accountability: null,
		limits: config.runtime,
	};

	if (shape.activation !== undefined) invocation.activation = shape.activation;
	if (shape.bundleEntries !== undefined) invocation.bundleEntries = shape.bundleEntries;

	let result: ConfinedLoadProbeResult;

	try {
		result = await probe(invocation);
	} catch {
		// A thrown probe is a host-side failure. It fails this extension closed and
		// must never abort the loader.
		return refuse(VALIDATION_INCOMPLETE, 'confined validation could not complete');
	}

	if (result.loadable) {
		return { ok: true, entrySource: entryRead.text };
	}

	if (NOT_LOADABLE_CODES.has(result.error.code)) {
		return refuse(result.error.code, safeDetail(result.error.message));
	}

	return refuse(VALIDATION_INCOMPLETE, 'confined validation could not complete');
}
