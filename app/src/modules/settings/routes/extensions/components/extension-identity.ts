import { EXTENSION_NAME_REGEX } from '@cairncms/constants';
import formatTitle from '@cairncms/format-title';

export type ExtensionIdentity = {
	title: string;
	packageName: string;
	scope?: string;
};

/**
 * Display-only identity. The canonical package name remains the durable identifier for
 * subjects, diagnostics detail, and logs; the derived title never feeds those.
 */
export function extensionIdentity(packageName: string): ExtensionIdentity {
	const localName = EXTENSION_NAME_REGEX.exec(packageName)?.[1];
	const scope = /^(@[^/]+)\//.exec(packageName)?.[1];

	if (!localName) return { packageName, title: packageName, ...(scope ? { scope } : {}) };

	return { packageName, title: formatTitle(localName), ...(scope ? { scope } : {}) };
}
