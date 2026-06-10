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
import type { Extension, ExtensionCapabilities, ExtensionOptions } from '@cairncms/types';
import { isTypeIn } from '@cairncms/utils';
import path from 'node:path';
import type { SanitizedExtensionError } from '../../utils/sanitize-extension-error.js';
import { resolveSandboxConfig, type SandboxConfig } from './sandbox-limits.js';
import { getConfinedSupervisor } from './supervisor.js';
import type { ConfinedInvocation, ConfinedLoadProbeResult } from './types.js';

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
};

export type ConfinedGateVerdict = ({ ok: true } & ConfinedEligibleEntry) | { ok: false; error: SanitizedExtensionError };

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
		return options.capabilities === undefined ? {} : { capabilities: options.capabilities };
	}

	if (options.type === 'bundle') {
		const seen = new Set<string>();
		const entryCapabilities: Record<string, ExtensionCapabilities> = {};
		let declared = false;

		for (const entry of options.entries) {
			if (!isTypeIn(entry, API_EXTENSION_TYPES) && !isTypeIn(entry, HYBRID_EXTENSION_TYPES)) continue;

			const key = `${entry.type}:${entry.name}`;

			if (seen.has(key)) return null;
			seen.add(key);

			if (entry.capabilities !== undefined) {
				entryCapabilities[key] = entry.capabilities;
				declared = true;
			}
		}

		return declared ? { entryCapabilities } : {};
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

	// The eval probe applies to the operation contract only, the one proven runtime
	// shape. Other confined server types are scanner-gated here and get their load
	// contract with their binding.
	if (isTypeIn(options, HYBRID_EXTENSION_TYPES)) {
		const probed = await probeOperationEntry(extension, options.path.api, deps);
		if (!probed.ok) return probed;

		return { ...probed, ...collected };
	}

	return { ok: true, ...collected };
}

/**
 * The dynamic half of the gate: reads the built operation entry under path
 * containment and the artifact cap, evaluates it in the confined child through the
 * load probe, and classifies the outcome. A not-loadable verdict refuses with the
 * probe's code. A host-side failure refuses `validation-incomplete`, never blaming
 * the extension for the gate's own failure. On success the probed bytes are
 * returned, so the binding executes exactly what was scanned and probed.
 */
async function probeOperationEntry(
	extension: Extension,
	entryRelative: string,
	deps: ConfinedLoadGateDeps
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
		input: null,
		accountability: null,
		limits: config.runtime,
	};

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
