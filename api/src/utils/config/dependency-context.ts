import type { ConfigKind } from '../../types/config.js';
import type { ConfigDependencyMap } from './descriptor.js';

/** Rejects undeclared or unpublished dependencies; `published.has` preserves `undefined` as a published value. */
export function makeDependencyAccessor<M extends ConfigDependencyMap>(
	declared: readonly ConfigKind[],
	published: ReadonlyMap<ConfigKind, unknown>
): <D extends Extract<keyof M, ConfigKind>>(kind: D) => M[D] {
	const declaredSet = new Set<ConfigKind>(declared);

	return <D extends Extract<keyof M, ConfigKind>>(kind: D): M[D] => {
		if (!declaredSet.has(kind)) {
			throw new Error(`Config kind requested an undeclared dependency "${kind}".`);
		}

		if (!published.has(kind)) {
			throw new Error(`Config dependency "${kind}" was not published before use.`);
		}

		return published.get(kind) as M[D];
	};
}
