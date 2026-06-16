import type { ConfinedOptionDelivery } from '@cairncms/types';
import type { ConfinedSecretScope } from './secret-scope.js';

export type PrepareOperationOptionsResult =
	| { ok: true; childOptions: Record<string, unknown>; referenceValues: Record<string, unknown> }
	// The declared reference option `key` has a present value that is not a string,
	// so it cannot be a secret and the operation fails before the handler runs.
	| { ok: false; key: string };

/**
 * Prepares a confined operation's resolved options for the guest. A key the
 * manifest declares as a reference must be a string secret: a non-empty value
 * becomes a per-invocation opaque handle minted in the scope with its clear value
 * kept out of band, an absent, null, or blank value is omitted as unset, and any
 * other type fails the preparation closed before the handler runs. Every other key
 * passes its clear value through. Null-prototype accumulators keep an option key
 * like `__proto__` an ordinary own property rather than a prototype mutation that
 * would drop the key.
 */
export function prepareOperationOptions(
	operationId: string,
	options: Record<string, unknown>,
	optionDelivery: ConfinedOptionDelivery | undefined,
	scope: ConfinedSecretScope
): PrepareOperationOptionsResult {
	const referenceKeys = new Set(Object.keys(optionDelivery ?? {}));
	const childOptions: Record<string, unknown> = Object.create(null);
	const referenceValues: Record<string, unknown> = Object.create(null);

	for (const [key, value] of Object.entries(options)) {
		if (!referenceKeys.has(key)) {
			childOptions[key] = value;
			continue;
		}

		if (value === null || value === undefined || value === '') continue;
		if (typeof value !== 'string') return { ok: false, key };

		const ref = scope.mint({ kind: 'flow-operation-option', operationId, key });
		childOptions[key] = { kind: 'secret-reference', ref };
		referenceValues[key] = value;
	}

	return { ok: true, childOptions, referenceValues };
}
