import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8'));

export default function getPinnedVersion(name: string): string {
	const version = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name];

	if (!version) {
		throw new Error(`No pinned version for "${name}" in the SDK package metadata`);
	}

	return version;
}
