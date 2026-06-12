import type { Accountability, ConfinedOptionDelivery, ExtensionCapabilities } from '@cairncms/types';
import {
	createConfinedHostBroker,
	type ConfinedHostBrokerDeps,
	type ConfinedLogEntry,
	type ConfinedSettingsSource,
} from './broker.js';
import { prepareOperationOptions } from './operation-options.js';
import { ConfinedSecretScope } from './secret-scope.js';
import type {
	ConfinedAccountability,
	ConfinedHostDispatcher,
	ConfinedInvocation,
	ConfinedResult,
	ConfinedRuntimeLimits,
} from './types.js';

export interface ConfinedOperationRequest {
	extensionId: string;
	// The operation type, which is also the contribution id the entry must declare.
	contributionId: string;
	// The directus_operations row id, the owner of this invocation's option handles.
	operationId: string;
	// The gate-probed built server entry bytes. Executed as bytes, never imported.
	entrySource: string;
	capabilities: ExtensionCapabilities;
	optionDelivery?: ConfinedOptionDelivery;
	// The resolved (clear) configured options for this operation.
	options: Record<string, unknown>;
	// The flow's `$last`, the only flow data the guest receives.
	input: unknown;
	accountability: Accountability | null;
}

export interface ConfinedOperationDeps {
	// The supervisor run seam: spawns the child and brokers its host calls.
	invoke: (invocation: ConfinedInvocation, dispatcher: ConfinedHostDispatcher) => Promise<ConfinedResult>;
	// The platform log sink. The broker redacts before this is called.
	log: (entry: ConfinedLogEntry) => void;
	getAxios?: ConfinedHostBrokerDeps['getAxios'];
	itemsService?: ConfinedHostBrokerDeps['itemsService'];
	brokerLimits: ConfinedHostBrokerDeps['limits'];
	runtimeLimits: ConfinedRuntimeLimits;
}

export type ConfinedOperationOutcome =
	| { ok: true; value: unknown }
	| { ok: false; error: { code: string; message: string } };

export interface ConfinedOperationResult {
	outcome: ConfinedOperationOutcome;
	// The opaque handles and the clear configured reference values, for Flow revision
	// redaction so neither a handle nor a configured secret persists in run history.
	redactionValues: string[];
}

// Settings ship dark in this milestone: no key is declared, so settings.get always
// returns null and mints no handle. A later slice defines declaration and storage.
const DARK_SETTINGS: ConfinedSettingsSource = {
	declared: [],
	value: () => null,
	hasSecret: () => false,
};

function toConfinedAccountability(accountability: Accountability | null): ConfinedAccountability | null {
	if (accountability === null) return null;
	return { user: accountability.user ?? null, role: accountability.role ?? null, admin: accountability.admin ?? false };
}

/**
 * The configured clear values of the declared reference options, read from the
 * request itself so they enter the redaction set on every path, including a
 * preparation failure that never returns them. The Flow reject revision carries
 * the clear options, so a configured secret must be scrubbed even when the
 * operation never ran.
 */
function configuredReferenceValues(
	options: Record<string, unknown>,
	optionDelivery: ConfinedOptionDelivery | undefined
): string[] {
	const referenceKeys = new Set(Object.keys(optionDelivery ?? {}));
	const values: string[] = [];

	for (const [key, value] of Object.entries(options)) {
		if (referenceKeys.has(key) && typeof value === 'string' && value.length > 0) values.push(value);
	}

	return values;
}

/**
 * Runs a confined Flow operation. A fresh secret scope and host broker are built
 * per invocation: declared reference options become opaque handles the guest holds,
 * the broker resolves a handle to its clear value only at brokered use, and the
 * supervisor runs the gate-probed entry bytes in the child, never importing them.
 * Every failure is a sanitized outcome, never a thrown error, and the minted handles
 * plus the configured reference values are returned for Flow revision redaction.
 */
export async function runConfinedOperation(
	request: ConfinedOperationRequest,
	deps: ConfinedOperationDeps
): Promise<ConfinedOperationResult> {
	const scope = new ConfinedSecretScope();
	const configuredReferences = configuredReferenceValues(request.options, request.optionDelivery);
	const redaction = () => [...new Set([...scope.redactionValues(), ...configuredReferences])];

	try {
		const prepared = prepareOperationOptions(request.operationId, request.options, request.optionDelivery, scope);

		if (!prepared.ok) {
			// Name the misconfigured option key, never its value.
			return {
				outcome: {
					ok: false,
					error: { code: 'invalid_request', message: `the operation option "${prepared.key}" is not a valid secret` },
				},
				redactionValues: redaction(),
			};
		}

		const brokerDeps: ConfinedHostBrokerDeps = {
			capabilities: request.capabilities,
			log: deps.log,
			settings: DARK_SETTINGS,
			accountability: request.accountability,
			limits: deps.brokerLimits,
			resolveSecret: async (binding, signal) => {
				if (signal.aborted) return null;

				if (binding.kind === 'flow-operation-option' && binding.operationId === request.operationId) {
					const value = prepared.referenceValues[binding.key];
					return typeof value === 'string' ? value : null;
				}

				return null;
			},
		};

		if (deps.getAxios !== undefined) brokerDeps.getAxios = deps.getAxios;
		if (deps.itemsService !== undefined) brokerDeps.itemsService = deps.itemsService;

		const dispatcher = createConfinedHostBroker(brokerDeps, scope);

		const invocation: ConfinedInvocation = {
			extensionId: request.extensionId,
			contributionId: request.contributionId,
			operationId: request.operationId,
			entrySource: request.entrySource,
			options: prepared.childOptions,
			input: request.input,
			accountability: toConfinedAccountability(request.accountability),
			limits: deps.runtimeLimits,
		};

		const result = await deps.invoke(invocation, dispatcher);

		return {
			outcome: result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error },
			redactionValues: redaction(),
		};
	} catch {
		return {
			outcome: { ok: false, error: { code: 'internal', message: 'the confined operation failed' } },
			redactionValues: redaction(),
		};
	}
}
