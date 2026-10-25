import type { ConfigFolder, ConfigKind, ConfigPlan } from '../types/config.js';
import { listConfigKinds } from './config/registry.js';

type FolderPreparationInput = {
	referencedKeys: ReadonlySet<string>;
	declaredFolders: readonly ConfigFolder[];
	currentFolderKeys: ReadonlySet<string>;
};

/**
 * Expects declarations already validated and normalized, and reference keys taken from reconciled fields.
 */
export function buildFolderPreparationPlan(input: FolderPreparationInput): ConfigPlan {
	const { referencedKeys, declaredFolders, currentFolderKeys } = input;
	const declaredByKey = new Map(declaredFolders.map((folder) => [folder.key, folder]));
	const creations = new Map<string, ConfigFolder>();
	const visiting = new Set<string>();

	const include = (key: string): void => {
		if (creations.has(key) || currentFolderKeys.has(key) || visiting.has(key)) return;

		const folder = declaredByKey.get(key);
		if (folder === undefined) return;

		visiting.add(key);
		if (typeof folder.parent === 'string') include(folder.parent);
		visiting.delete(key);

		creations.set(key, folder);
	};

	for (const key of referencedKeys) include(key);

	return folderCreationPlan([...creations.values()]);
}

export function assertFolderPreparationCreationsOnly(plan: ConfigPlan): void {
	for (const kind of listConfigKinds()) {
		const slice = plan[kind];
		const unexpectedCreate = kind !== 'folders' && slice.create.length > 0;

		if (unexpectedCreate || slice.update.length > 0 || slice.delete.length > 0) {
			throw new Error(`Folder preparation plan carries a change other than folder creation in "${kind}".`);
		}
	}

	if (plan.protections.length > 0) {
		throw new Error('Folder preparation plan carries a protection.');
	}
}

function folderCreationPlan(creations: ConfigFolder[]): ConfigPlan {
	const slices = Object.fromEntries(
		listConfigKinds().map((kind) => [kind, { create: [], update: [], delete: [] }])
	) as unknown as Pick<ConfigPlan, ConfigKind>;

	return {
		...slices,
		folders: { create: creations, update: [], delete: [] },
		managedResources: Object.freeze<ConfigKind[]>(['folders']),
		protections: [],
	};
}
