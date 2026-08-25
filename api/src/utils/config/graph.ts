import { CONFIG_KINDS, type ConfigKind } from '../../types/config.js';
import { getDescriptor } from './registry.js';

/** Topological order (dependencies first). Throws on a dependency outside `nodes` (unknown) or on a cycle. */
export function topologicalOrder<T extends string>(
	nodes: readonly T[],
	dependenciesOf: (node: T) => readonly T[]
): T[] {
	const known = new Set<T>(nodes);
	const ordered: T[] = [];
	const visited = new Set<T>();
	const onStack = new Set<T>();

	const visit = (node: T): void => {
		if (visited.has(node)) return;
		if (onStack.has(node)) throw new Error(`Config dependency cycle involving "${node}".`);

		onStack.add(node);

		for (const dependency of dependenciesOf(node)) {
			if (!known.has(dependency)) {
				throw new Error(`Config kind "${node}" declares an unknown dependency "${dependency}".`);
			}

			visit(dependency);
		}

		onStack.delete(node);
		visited.add(node);
		ordered.push(node);
	};

	for (const node of nodes) visit(node);
	return ordered;
}

/** Every node reachable from `seeds` through dependencies, seeds included. */
export function dependencyClosure<T extends string>(
	seeds: readonly T[],
	dependenciesOf: (node: T) => readonly T[]
): Set<T> {
	const reached = new Set<T>();
	const pending = [...seeds];

	while (pending.length > 0) {
		const node = pending.pop()!;
		if (reached.has(node)) continue;
		reached.add(node);

		for (const dependency of dependenciesOf(node)) {
			if (!reached.has(dependency)) pending.push(dependency);
		}
	}

	return reached;
}

function configDependencyOrder(): ConfigKind[] {
	return topologicalOrder(CONFIG_KINDS, (kind) => getDescriptor(kind).dependencies);
}

/** The given config kinds in dependency order (dependencies first). */
export function dependencyOrder(kinds: readonly ConfigKind[]): ConfigKind[] {
	const wanted = new Set(kinds);
	return configDependencyOrder().filter((kind) => wanted.has(kind));
}

/** The given config kinds in reverse dependency order (dependents first). */
export function reverseDependencyOrder(kinds: readonly ConfigKind[]): ConfigKind[] {
	return dependencyOrder(kinds).reverse();
}
