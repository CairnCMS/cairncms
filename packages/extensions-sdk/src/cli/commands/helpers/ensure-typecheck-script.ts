export default function ensureTypecheckScript(manifest: Record<string, any>): void {
	const scripts = (manifest['scripts'] ?? {}) as Record<string, string>;

	if ('typescript' in (manifest['devDependencies'] ?? {}) && !('typecheck' in scripts)) {
		manifest['scripts'] = { ...scripts, typecheck: 'tsc --noEmit' };
	}
}
