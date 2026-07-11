import { API_EXTENSION_TYPES, APP_EXTENSION_TYPES, HYBRID_EXTENSION_TYPES } from '@cairncms/constants';
import type { ExtensionOptionsBundleEntry } from '@cairncms/types';
import { isIn, isTypeIn, pluralize, pluralizeToIdentifier } from '@cairncms/utils';
import { pathToRelativeUrl } from '@cairncms/utils/node';
import path from 'path';

export default function generateBundleEntrypoint(mode: 'app' | 'api', entries: ExtensionOptionsBundleEntry[]): string {
	const types = [...(mode === 'app' ? APP_EXTENSION_TYPES : API_EXTENSION_TYPES), ...HYBRID_EXTENSION_TYPES];

	const entriesForTypes = entries.filter((entry) => isIn(entry.type, types));

	const imports = entriesForTypes.map((entry, index) => {
		let entryPath: string;

		if (isTypeIn(entry, HYBRID_EXTENSION_TYPES)) {
			entryPath = mode === 'app' ? entry.source.app : entry.source.api;
		} else {
			entryPath = entry.source;
		}

		return `import e${index} from './${pathToRelativeUrl(path.resolve(entryPath))}';`;
	});

	const exports = types.map((type) => {
		const entries = entriesForTypes.reduce<string[]>((result, entry, index) => {
			if (entry.type !== type) return result;

			if (mode === 'app') {
				result.push(`e${index}`);
			} else {
				result.push(`{name:'${entry.name}',config:e${index}}`);
			}

			return result;
		}, []);

		// A hyphenated type pluralizes to a key that is not a valid identifier, so the
		// array is declared under an identifier-safe name and exported under the
		// canonical key as a string export name.
		const key = pluralize(type);
		const identifier = pluralizeToIdentifier(type);

		if (identifier === key) {
			return `export const ${key} = [${entries.join(',')}];`;
		}

		return `const ${identifier} = [${entries.join(',')}];export { ${identifier} as ${JSON.stringify(key)} };`;
	});

	return `${imports.join('')}${exports.join('')}`;
}
