import type { PrimaryKey } from '../types/index.js';

export const MUTATION_GUARD = Symbol('cairnMutationGuard');

export interface MutationGuard {
	beforeUpdate(effectivePayload: Readonly<Record<string, unknown>>, keys: PrimaryKey[]): Promise<void>;
}

export function withMutationGuard<T extends object>(opts: T, guard: MutationGuard): T & Record<symbol, MutationGuard> {
	return { ...opts, [MUTATION_GUARD]: guard };
}

export function getMutationGuard(opts: unknown): MutationGuard | undefined {
	if (opts && typeof opts === 'object' && MUTATION_GUARD in opts) {
		return (opts as Record<symbol, MutationGuard>)[MUTATION_GUARD];
	}

	return undefined;
}
