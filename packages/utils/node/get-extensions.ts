import {
	EXTENSION_NAME_REGEX,
	EXTENSION_PKG_KEY,
	HYBRID_EXTENSION_TYPES,
	NESTED_EXTENSION_TYPES,
	ExtensionManifest,
	RESERVED_EVENT_NAMESPACE_ERROR,
	isReservedEventNamespaceError,
} from '@cairncms/constants';
import type { ApiExtensionType, AppExtensionType, Extension } from '@cairncms/types';
import fse from 'fs-extra';
import path from 'path';
import { isIn, isTypeIn } from './array-helpers.js';
import { listFolders } from './list-folders.js';
import { pluralize } from './pluralize.js';
import { resolvePackage } from './resolve-package.js';

export type ExtensionDiscoveryFailure = {
	name: string;
	local: boolean;
	error: unknown;
};

export type OnExtensionDiscoveryFailure = (failure: ExtensionDiscoveryFailure) => void;

export const findExtension = async (folder: string, filename: string) => {
	if (await fse.exists(path.join(folder, `${filename}.cjs`))) return `${filename}.cjs`;
	if (await fse.exists(path.join(folder, `${filename}.mjs`))) return `${filename}.mjs`;
	return `${filename}.js`;
};

async function parsePackageExtension(extensionName: string, extensionPath: string, local: boolean): Promise<Extension> {
	const extensionManifest: Record<string, any> = await fse.readJSON(path.join(extensionPath, 'package.json'));

	let parsedManifest;

	try {
		parsedManifest = ExtensionManifest.parse(extensionManifest);
	} catch (error) {
		if (isReservedEventNamespaceError(error)) {
			throw new Error(RESERVED_EVENT_NAMESPACE_ERROR);
		}

		throw new Error(`The extension manifest of "${extensionName}" is not valid.\n${error}`);
	}

	const extensionOptions = parsedManifest[EXTENSION_PKG_KEY];

	if (extensionOptions.type === 'bundle') {
		return {
			path: extensionPath,
			name: parsedManifest.name,
			version: parsedManifest.version,
			type: extensionOptions.type,
			entrypoint: {
				app: extensionOptions.path.app,
				api: extensionOptions.path.api,
			},
			entries: extensionOptions.entries,
			host: extensionOptions.host,
			local,
			...(extensionOptions.runtime !== undefined && { runtime: extensionOptions.runtime }),
			...(extensionOptions.settings !== undefined && { settings: extensionOptions.settings }),
		};
	} else if (isTypeIn(extensionOptions, HYBRID_EXTENSION_TYPES)) {
		return {
			path: extensionPath,
			name: parsedManifest.name,
			version: parsedManifest.version,
			type: extensionOptions.type,
			entrypoint: {
				app: extensionOptions.path.app,
				api: extensionOptions.path.api,
			},
			host: extensionOptions.host,
			local,
			...(extensionOptions.runtime !== undefined && { runtime: extensionOptions.runtime }),
			...(extensionOptions.settings !== undefined && { settings: extensionOptions.settings }),
		};
	} else {
		return {
			path: extensionPath,
			name: parsedManifest.name,
			version: parsedManifest.version,
			type: extensionOptions.type,
			entrypoint: extensionOptions.path,
			host: extensionOptions.host,
			local,
			...(extensionOptions.runtime !== undefined && { runtime: extensionOptions.runtime }),
			...(extensionOptions.settings !== undefined && { settings: extensionOptions.settings }),
		};
	}
}

export async function resolvePackageExtensions(
	root: string,
	extensionNames?: string[],
	onFailure?: OnExtensionDiscoveryFailure
): Promise<Extension[]> {
	const extensions: Extension[] = [];

	const local = extensionNames === undefined;

	if (extensionNames === undefined) {
		extensionNames = await listFolders(root);
		extensionNames = extensionNames.filter((name) => EXTENSION_NAME_REGEX.test(name));
	}

	for (const extensionName of extensionNames) {
		try {
			const extensionPath = local ? path.join(root, extensionName) : resolvePackage(extensionName, root);

			extensions.push(await parsePackageExtension(extensionName, extensionPath, local));
		} catch (error) {
			if (onFailure) {
				onFailure({ name: extensionName, local, error });
				continue;
			}

			throw error;
		}
	}

	return extensions;
}

export async function getPackageExtensions(
	root: string,
	onFailure?: OnExtensionDiscoveryFailure
): Promise<Extension[]> {
	let pkg: { dependencies?: Record<string, string> };

	try {
		pkg = await fse.readJSON(path.resolve(root, 'package.json'));
	} catch {
		throw new Error('Current folder does not contain a package.json file');
	}

	const extensionNames = Object.keys(pkg.dependencies ?? {}).filter((dep) => EXTENSION_NAME_REGEX.test(dep));

	return resolvePackageExtensions(root, extensionNames, onFailure);
}

export async function getLocalExtensions(root: string): Promise<Extension[]> {
	const extensions: Extension[] = [];

	for (const extensionType of NESTED_EXTENSION_TYPES) {
		const typeDir = pluralize(extensionType);
		const typePath = path.resolve(root, typeDir);

		try {
			const extensionNames = await listFolders(typePath);

			for (const extensionName of extensionNames) {
				const extensionPath = path.join(typePath, extensionName);

				if (isIn(extensionType, HYBRID_EXTENSION_TYPES)) {
					extensions.push({
						path: extensionPath,
						name: extensionName,
						type: extensionType,
						entrypoint: {
							app: await findExtension(extensionPath, 'app'),
							api: await findExtension(extensionPath, 'api'),
						},
						local: true,
					});
				} else {
					extensions.push({
						path: extensionPath,
						name: extensionName,
						type: extensionType as AppExtensionType | ApiExtensionType,
						entrypoint: await findExtension(extensionPath, 'index'),
						local: true,
					});
				}
			}
		} catch (e) {
			throw new Error(`Extension folder "${typePath}" couldn't be opened`);
		}
	}

	return extensions;
}
