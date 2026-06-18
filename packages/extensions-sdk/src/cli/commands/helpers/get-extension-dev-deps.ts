import { API_EXTENSION_TYPES, APP_EXTENSION_TYPES, HYBRID_EXTENSION_TYPES } from '@cairncms/constants';
import type { ExtensionType } from '@cairncms/types';
import { isIn } from '@cairncms/utils';
import type { Language } from '../../types.js';
import getPinnedVersion from '../../utils/get-pinned-version.js';
import getSdkVersion from '../../utils/get-sdk-version.js';

export default function getExtensionDevDeps(
	type: ExtensionType | ExtensionType[],
	language: Language | Language[] = []
): Record<string, string> {
	const types = Array.isArray(type) ? type : [type];
	const languages = Array.isArray(language) ? language : [language];

	const deps: Record<string, string> = {
		'@cairncms/extensions-sdk': getSdkVersion(),
	};

	if (languages.includes('typescript')) {
		if (types.some((type) => isIn(type, [...API_EXTENSION_TYPES, ...HYBRID_EXTENSION_TYPES]))) {
			deps['@types/node'] = getPinnedVersion('@types/node');
		}

		deps['typescript'] = getPinnedVersion('typescript');
	}

	if (types.some((type) => isIn(type, [...APP_EXTENSION_TYPES, ...HYBRID_EXTENSION_TYPES]))) {
		deps['vue'] = getPinnedVersion('vue');
	}

	return deps;
}
