import { CONFINED_RUNTIME } from '@cairncms/constants';
import type { BundleExtension, Extension, ExtensionCapabilities, ExtensionType } from '@cairncms/types';
import logger from '../logger.js';
import type { SanitizedExtensionError } from '../utils/sanitize-extension-error.js';
import type { SandboxPosture } from './confined/sandbox-hardening.js';

// A confined bundle's server entries register independently, so each carries its own
// status and reason. An app entry, or an inherited bundle's entry, has no per-entry
// status.
export type ExtensionDiagnosticEntry = {
	name: string;
	type: string;
	status?: 'loaded' | 'failed';
	reason?: SanitizedExtensionError;
	capabilities?: ExtensionCapabilities;
};

export type ExtensionDiagnostic = {
	name: string;
	type: ExtensionType | null;
	local: boolean;
	version?: string;
	entries?: ExtensionDiagnosticEntry[];
	// `partial` is a confined bundle whose server entries did not all register the same
	// way: some loaded, some failed.
	status: 'loaded' | 'failed' | 'discovered' | 'partial';
	reason?: SanitizedExtensionError;
	// A confined top-level extension carries its gate-validated declared capabilities here.
	// A confined bundle carries them per entry instead, so the bundle row has none.
	capabilities?: ExtensionCapabilities;
	// Set to the confined runtime only when the extension runs sandboxed, omitted otherwise.
	runtime?: typeof CONFINED_RUNTIME;
	// Present only on a settings-declaring owner: whether its settings are manageable, with
	// the sanitized reason when they are not. Status only, never the declaration.
	settings?: { status: 'available' | 'unavailable'; reason?: SanitizedExtensionError };
};

// The global confined-runtime metadata on the diagnostics response. `not-required` means no
// confined extension this load (the sandbox env is never resolved), `available` carries the
// resolved posture, `unavailable` means a confined extension was present but the runtime did
// not resolve.
type ConfinedPostureSummary = {
	mode: SandboxPosture['mode'];
	decision: SandboxPosture['decision'];
	applied: SandboxPosture['applied'];
	missing: SandboxPosture['missing'];
	cgroupMechanic: SandboxPosture['cgroupMechanic'];
};

export type ConfinedRuntimeMeta = {
	state: 'not-required' | 'available' | 'unavailable';
	posture: ConfinedPostureSummary | null;
};

// The manager's state as the recording functions read it. The manager owns every field and
// injects lookups, so this module holds no state and imports nothing back.
export interface DiagnosticsView {
	diagnostics: ExtensionDiagnostic[];
	capabilitiesOf(extension: Extension): ExtensionCapabilities | undefined;
	settingsStatusOf(extension: Extension): ExtensionDiagnostic['settings'] | undefined;
}

export function copyDiagnostics(diagnostics: ExtensionDiagnostic[]): ExtensionDiagnostic[] {
	return diagnostics.map((diagnostic) => {
		const copy: ExtensionDiagnostic = {
			name: diagnostic.name,
			type: diagnostic.type,
			local: diagnostic.local,
			status: diagnostic.status,
		};

		if (diagnostic.version) copy.version = diagnostic.version;

		if (diagnostic.entries) {
			copy.entries = diagnostic.entries.map((entry) => ({
				...entry,
				...(entry.reason && { reason: { ...entry.reason } }),
				...(entry.capabilities && { capabilities: structuredClone(entry.capabilities) }),
			}));
		}

		if (diagnostic.reason) copy.reason = { ...diagnostic.reason };
		if (diagnostic.capabilities) copy.capabilities = structuredClone(diagnostic.capabilities);

		if (diagnostic.settings) {
			copy.settings = {
				status: diagnostic.settings.status,
				...(diagnostic.settings.reason && { reason: { ...diagnostic.settings.reason } }),
			};
		}

		if (diagnostic.runtime) copy.runtime = diagnostic.runtime;

		return copy;
	});
}

export function recordLoaded(view: DiagnosticsView, extension: Extension): void {
	const diagnostic: ExtensionDiagnostic = {
		name: extension.name,
		type: extension.type,
		local: extension.local,
		status: 'loaded',
	};

	if (extension.version) diagnostic.version = extension.version;

	if (extension.type === 'bundle') {
		diagnostic.entries = extension.entries.map((entry) => ({ name: entry.name, type: entry.type }));
	}

	const capabilities = view.capabilitiesOf(extension);
	if (capabilities !== undefined) diagnostic.capabilities = capabilities;

	if (extension.runtime === CONFINED_RUNTIME) diagnostic.runtime = extension.runtime;

	const settings = view.settingsStatusOf(extension);
	if (settings !== undefined) diagnostic.settings = settings;

	view.diagnostics.push(diagnostic);
}

export function recordFailed(view: DiagnosticsView, extension: Extension, reason: SanitizedExtensionError): void {
	const diagnostic: ExtensionDiagnostic = {
		name: extension.name,
		type: extension.type,
		local: extension.local,
		status: 'failed',
		reason,
	};

	if (extension.version) diagnostic.version = extension.version;

	if (extension.type === 'bundle') {
		diagnostic.entries = extension.entries.map((entry) => ({ name: entry.name, type: entry.type }));
	}

	const capabilities = view.capabilitiesOf(extension);
	if (capabilities !== undefined) diagnostic.capabilities = capabilities;

	if (extension.runtime === CONFINED_RUNTIME) diagnostic.runtime = extension.runtime;

	const settings = view.settingsStatusOf(extension);
	if (settings !== undefined) diagnostic.settings = settings;

	view.diagnostics.push(diagnostic);
}

export function recordBundle(
	view: DiagnosticsView,
	extension: BundleExtension,
	entries: ExtensionDiagnosticEntry[]
): void {
	const failed = entries.filter((entry) => entry.status === 'failed').length;
	const loaded = entries.length - failed;

	let status: ExtensionDiagnostic['status'] = 'partial';
	if (failed === 0) status = 'loaded';
	else if (loaded === 0) status = 'failed';

	const diagnostic: ExtensionDiagnostic = {
		name: extension.name,
		type: extension.type,
		local: extension.local,
		status,
		entries,
	};

	if (extension.version) diagnostic.version = extension.version;

	if (extension.runtime === CONFINED_RUNTIME) diagnostic.runtime = extension.runtime;

	const settings = view.settingsStatusOf(extension);
	if (settings !== undefined) diagnostic.settings = settings;

	view.diagnostics.push(diagnostic);
}

export function recordAppDiagnostics(
	view: DiagnosticsView,
	discovered: Extension[],
	appBundleFailure: SanitizedExtensionError | null
): void {
	for (const extension of discovered) {
		const diagnostic: ExtensionDiagnostic = {
			name: extension.name,
			type: extension.type,
			local: extension.local,
			status: 'discovered',
		};

		if (extension.version) diagnostic.version = extension.version;

		const settings = view.settingsStatusOf(extension);
		if (settings !== undefined) diagnostic.settings = settings;

		view.diagnostics.push(diagnostic);
	}

	if (appBundleFailure) {
		view.diagnostics.push({
			name: '(app bundle)',
			type: null,
			local: false,
			status: 'failed',
			reason: appBundleFailure,
		});
	}
}

export function summarizeConfinedRuntime(
	posture: SandboxPosture | undefined,
	unavailable: boolean
): ConfinedRuntimeMeta {
	if (posture !== undefined) {
		return {
			state: 'available',
			posture: {
				mode: posture.mode,
				decision: posture.decision,
				applied: [...posture.applied],
				missing: [...posture.missing],
				cgroupMechanic: posture.cgroupMechanic,
			},
		};
	}

	if (unavailable) return { state: 'unavailable', posture: null };

	return { state: 'not-required', posture: null };
}

export function logExtensionStatus(diagnostics: ExtensionDiagnostic[]): void {
	const loaded = diagnostics.filter((diagnostic) => diagnostic.status === 'loaded');

	if (loaded.length > 0) {
		logger.info(`Loaded extensions: ${loaded.map((diagnostic) => diagnostic.name).join(', ')}`);
	}

	const discovered = diagnostics.filter((diagnostic) => diagnostic.status === 'discovered');

	if (discovered.length > 0) {
		logger.info(`Discovered app extensions: ${discovered.map((diagnostic) => diagnostic.name).join(', ')}`);
	}

	const failed = diagnostics.filter((diagnostic) => diagnostic.status === 'failed');

	if (failed.length > 0) {
		logger.warn(
			`Failed to load extensions: ${failed
				.map((diagnostic) => `${diagnostic.name} (${diagnostic.reason?.code ?? 'UNKNOWN'})`)
				.join(', ')}`
		);
	}

	const partial = diagnostics.filter((diagnostic) => diagnostic.status === 'partial');

	if (partial.length > 0) {
		logger.warn(
			`Partially loaded confined bundles: ${partial
				.map((diagnostic) => {
					const failedEntries = (diagnostic.entries ?? [])
						.filter((entry) => entry.status === 'failed')
						.map((entry) => `${entry.type}:${entry.name} (${entry.reason?.code ?? 'UNKNOWN'})`)
						.join(', ');

					return `${diagnostic.name} [${failedEntries}]`;
				})
				.join('; ')}`
		);
	}
}
