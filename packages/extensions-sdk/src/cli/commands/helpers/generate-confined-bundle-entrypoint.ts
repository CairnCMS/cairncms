import { API_EXTENSION_TYPES, HYBRID_EXTENSION_TYPES } from '@cairncms/constants';
import type { ExtensionOptionsBundleEntry } from '@cairncms/types';
import { isIn, isTypeIn } from '@cairncms/utils';
import { pathToRelativeUrl } from '@cairncms/utils/node';
import path from 'path';

const SERVER_ENTRY_TYPES = [...API_EXTENSION_TYPES, ...HYBRID_EXTENSION_TYPES];

/**
 * Generates the confined bundle's server entry module: an ESM module that imports
 * every declared server entry's source and default-exports them keyed by
 * `type:name`. Built as an IIFE under globalName `CairnBundle`, this exposes
 * `CairnBundle.default[type:name]` as each entry's confined config, the shape the
 * gate probes and the binding selects. App entries are excluded; they keep the
 * browser bundle.
 */
export default function generateConfinedBundleEntrypoint(entries: ExtensionOptionsBundleEntry[]): string {
	const serverEntries = entries.filter((entry) => isIn(entry.type, SERVER_ENTRY_TYPES));

	const imports = serverEntries.map((entry, index) => {
		const source = isTypeIn(entry, HYBRID_EXTENSION_TYPES) ? entry.source.api : entry.source;
		// The specifier is built as data, not interpolated raw, so a quote or newline
		// in a manifest source path cannot break out and inject code into this module.
		return `import e${index} from ${JSON.stringify(`./${pathToRelativeUrl(path.resolve(source))}`)};`;
	});

	const members = serverEntries.map((entry, index) => `${JSON.stringify(`${entry.type}:${entry.name}`)}:e${index}`);

	return `${imports.join('')}export default {${members.join(',')}};`;
}
