export function isSystemCollection(collection: string): boolean {
	// @ts-expect-error actual values are injected at build time via esbuild-plugin-replace (see tsup.config.js)
	const collections: string[] = __SYSTEM_COLLECTION_NAMES__;
	return collections.includes(collection);
}
