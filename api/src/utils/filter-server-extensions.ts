import { CONFINED_RUNTIME } from '@cairncms/constants';
import type { Extension } from '@cairncms/types';

// The discovered extension types the inherited full-authority server loader
// imports. Anything else (an app-only extension) is never imported by the server
// register methods, so it passes through untouched.
const SERVER_LOADER_TYPES = new Set<string>(['hook', 'endpoint', 'operation', 'bundle']);

/**
 * Filters discovered extensions to those the inherited full-authority server
 * loader may import. A `confined-server` extension is excluded so it never reaches
 * the full-authority import path, the central invariant that a confined extension
 * never runs full-authority. This never imports or executes extension code.
 */
export function filterServerExtensions(extensions: Extension[]): Extension[] {
	return extensions.filter((extension) => {
		if (SERVER_LOADER_TYPES.has(extension.type) === false) return true;

		return extension.runtime !== CONFINED_RUNTIME;
	});
}
