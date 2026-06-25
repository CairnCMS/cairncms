import { ExtensionSecretPointerSchema } from '@cairncms/constants';
import type { ExtensionSettings } from '@cairncms/types';
import { readRawConfigSecret } from '../../utils/read-raw-config-secret.js';
import type { StoredSettingRow } from '../../services/extension-settings-store.js';
import type { ConfinedSettingsSource } from './broker.js';
import type { ConfinedSecretBinding } from './secret-scope.js';

type ExtensionSettingBinding = Extract<ConfinedSecretBinding, { kind: 'extension-setting' }>;

export interface ConfinedSettingsAccess {
	source: ConfinedSettingsSource;
	resolveExtensionSecret(binding: ExtensionSettingBinding, signal: AbortSignal): Promise<string | null>;
}

/**
 * Builds the confined settings source and the extension-setting secret resolver for one
 * subject. It imports neither extensions.ts nor the service. The caller injects the
 * owner declaration and a row reader, so the runtime path cannot close an import cycle.
 */
export function buildConfinedSettingsAccess(deps: {
	declaration: ExtensionSettings | undefined;
	readRows: (signal?: AbortSignal) => Promise<StoredSettingRow[]>;
}): ConfinedSettingsAccess {
	const { declaration, readRows } = deps;

	const globalDeclared = new Map<string, { type: string; sensitive: boolean }>();

	for (const [key, decl] of Object.entries(declaration ?? {})) {
		if (decl.scope === 'global') {
			globalDeclared.set(key.toLowerCase(), { type: decl.type, sensitive: decl.sensitive === true });
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
		if (declared === undefined || !declared.sensitive) return null;

		const pointer = ExtensionSecretPointerSchema.safeParse(await storedValue(normalizedKey, signal));
		if (!pointer.success) return null;

		return readRawConfigSecret(pointer.data.name);
	}

	const source: ConfinedSettingsSource = {
		declared: [...globalDeclared].map(([key, decl]) => ({ key, sensitive: decl.sensitive })),
		async value(key, signal) {
			const normalizedKey = key.toLowerCase();
			const declared = globalDeclared.get(normalizedKey);
			if (declared === undefined || declared.sensitive) return null;

			const value = await storedValue(normalizedKey, signal);
			if (typeof value !== declared.type) return null;
			if (declared.type === 'number' && !Number.isFinite(value)) return null;

			return value;
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

/**
 * The access for a subject that owns no settings: an empty declaration reads every key as
 * null and resolves no secret. Derived from the builder so there is one definition of empty.
 */
export const EMPTY_SETTINGS_ACCESS = buildConfinedSettingsAccess({ declaration: undefined, readRows: async () => [] });
