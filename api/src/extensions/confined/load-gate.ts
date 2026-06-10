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
import type { Extension, ExtensionOptions } from '@cairncms/types';
import { isTypeIn } from '@cairncms/utils';
import path from 'node:path';
import type { SanitizedExtensionError } from '../../utils/sanitize-extension-error.js';

// The manifest is a package.json, far below this on any real package.
export const MAX_MANIFEST_BYTES = 256 * 1024;

const GENERIC_DETAIL = 'confined validation failed';

export type ConfinedGateVerdict = { ok: true } | { ok: false; error: SanitizedExtensionError };

export interface ConfinedLoadGateDeps {
	scan?: typeof scanCandidateSource;
	readFile?: typeof readFileCapped;
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

function refuse(code: ExtensionValidationReasonCode, detail: string): ConfinedGateVerdict {
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

	const entries = serverSourceEntries(options);

	if (entries === null) {
		return refuse('manifest-invalid', 'the confined declaration is not valid for this extension type');
	}

	const { reasons } = await scan({ root: extension.path, entries });
	const reason = reasons[0];

	if (reason !== undefined) {
		return { ok: false, error: confinedValidationError(reason) };
	}

	return { ok: true };
}
