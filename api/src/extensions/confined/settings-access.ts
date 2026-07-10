import type { ExtensionSettings } from '@cairncms/types';
import type { StoredSettingRow } from '../../services/extension-settings-store.js';
import { resolveDeclaredSecret, resolveDeclaredValue, type DeclaredSetting } from '../settings-resolver.js';
import type { ConfinedSettingsSource } from './broker.js';
import type { ConfinedSecretBinding } from './secret-scope.js';

type ExtensionSettingBinding = Extract<ConfinedSecretBinding, { kind: 'extension-setting' }>;

export interface ConfinedSettingsAccess {
	source: ConfinedSettingsSource;
	resolveExtensionSecret(binding: ExtensionSettingBinding, signal: AbortSignal): Promise<string | null>;
}

/**
 * Builds the confined settings source and the extension-setting secret resolver for one
 * subject. It imports neither extensions.ts nor the service. The caller injects the subject,
 * the owner declaration, and a row reader, so the runtime path cannot close an import cycle.
 */
export function buildConfinedSettingsAccess(deps: {
	subject: string;
	declaration: ExtensionSettings | undefined;
	readRows: (signal?: AbortSignal) => Promise<StoredSettingRow[]>;
}): ConfinedSettingsAccess {
	const { subject, declaration, readRows } = deps;

	const globalDeclared = new Map<string, DeclaredSetting>();

	for (const [key, decl] of Object.entries(declaration ?? {})) {
		if (decl.scope === 'global') {
			globalDeclared.set(key.toLowerCase(), { type: decl.type, secret: decl.secret?.source });
		}
	}

	let cache: StoredSettingRow[] | undefined;

	async function loadRows(signal?: AbortSignal): Promise<StoredSettingRow[]> {
		if (cache !== undefined) return cache;
		if (signal?.aborted) return [];

		const rows = await readRows(signal);

		// An aborted or failed read is not cached, so a later live read can still succeed.
		if (signal?.aborted) return rows;

		cache = rows;
		return cache;
	}

	async function storedValue(normalizedKey: string, signal?: AbortSignal): Promise<unknown> {
		const rows = await loadRows(signal);
		return rows.find((row) => row.key.toLowerCase() === normalizedKey)?.value;
	}

	async function resolveSecretForKey(normalizedKey: string, signal?: AbortSignal): Promise<string | null> {
		const declared = globalDeclared.get(normalizedKey);
		if (declared === undefined) return null;

		return resolveDeclaredSecret(subject, normalizedKey, declared, () => storedValue(normalizedKey, signal));
	}

	const source: ConfinedSettingsSource = {
		declared: [...globalDeclared].map(([key, decl]) => ({ key, isSecret: decl.secret !== undefined })),
		async value(key, signal) {
			const normalizedKey = key.toLowerCase();
			const declared = globalDeclared.get(normalizedKey);
			if (declared === undefined || declared.secret !== undefined) return null;

			return resolveDeclaredValue(declared, await storedValue(normalizedKey, signal));
		},
		async hasSecret(key, signal) {
			return (await resolveSecretForKey(key.toLowerCase(), signal)) !== null;
		},
	};

	return {
		source,
		resolveExtensionSecret: (binding, signal) => resolveSecretForKey(binding.key.toLowerCase(), signal),
	};
}

// The access for a subject that owns no settings: an empty declaration reads every key as
// null and resolves no secret. Derived from the builder so there is one definition of empty.
export const EMPTY_SETTINGS_ACCESS = buildConfinedSettingsAccess({
	subject: 'cairncms-extension-none',
	declaration: undefined,
	readRows: async () => [],
});
