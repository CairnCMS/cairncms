import type { ExtensionSettings, ExtensionSettingsReader } from '@cairncms/types';
import type { StoredSettingRow } from '../services/extension-settings-store.js';
import { resolveDeclaredSecret, resolveDeclaredValue } from './settings-resolver.js';

/**
 * Builds the full-authority settings reader for one subject. The subject is bound at
 * registration and never caller-supplied, so an extension can read only its own declared
 * settings. The declaration is resolved per call, so an owner gated ineligible after load
 * reads nothing. It imports neither extensions.ts nor the service, the caller injects the
 * declaration getter and the row readers, so the runtime path cannot close an import cycle.
 */
export function buildExtensionSettingsReader(deps: {
	subject: string;
	getDeclaration: () => ExtensionSettings | undefined;
	readGlobalRows: () => Promise<StoredSettingRow[]>;
	readCollectionRows: (collection: string) => Promise<StoredSettingRow[]>;
}): ExtensionSettingsReader {
	const { subject, getDeclaration, readGlobalRows, readCollectionRows } = deps;

	return {
		async get(key, options) {
			if (typeof key !== 'string' || key.length === 0) return null;

			const declaration = getDeclaration();
			if (declaration === undefined) return null;

			const normalized = key.toLowerCase();
			const declared = declaration[normalized];
			if (declared === undefined) return null;

			const declaredScope = declared.scope ?? 'global';

			let readRows: () => Promise<StoredSettingRow[]>;

			if (options !== undefined) {
				if (options.scope !== 'collection') return null;
				if (declaredScope !== 'collection') return null;
				if (typeof options.collection !== 'string' || options.collection.length === 0) return null;

				const collection = options.collection;
				readRows = () => readCollectionRows(collection);
			} else {
				if (declaredScope !== 'global') return null;

				readRows = readGlobalRows;
			}

			const readStored = async () => (await readRows()).find((row) => row.key.toLowerCase() === normalized)?.value;
			const setting = { type: declared.type, secret: declared.secret?.source };

			if (setting.secret !== undefined) {
				return resolveDeclaredSecret(subject, normalized, setting, readStored);
			}

			return resolveDeclaredValue(setting, await readStored());
		},
	};
}

// The reader for a context with no settings owner, such as a built-in operation: every
// read resolves null. One definition, so the member is always present and never optional.
export const EMPTY_EXTENSION_SETTINGS_READER: ExtensionSettingsReader = {
	get: async () => null,
};
