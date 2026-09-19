import type { Knex } from 'knex';
import type { PrimaryKey } from '../types/index.js';

export const MUTATION_GUARD = Symbol('cairnMutationGuard');

export interface MutationGuard {
	beforeUpdate?(effectivePayload: Readonly<Record<string, unknown>>, keys: PrimaryKey[], trx: Knex): Promise<void>;
	beforeCreate?(effectivePayload: Readonly<Record<string, unknown>>, trx: Knex): Promise<void>;
	beforeDelete?(keys: PrimaryKey[], trx: Knex): Promise<void>;
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

export function composeMutationGuards(guards: readonly MutationGuard[]): MutationGuard {
	return {
		async beforeUpdate(effectivePayload, keys, trx) {
			for (const guard of guards) await guard.beforeUpdate?.(effectivePayload, keys, trx);
		},
		async beforeCreate(effectivePayload, trx) {
			for (const guard of guards) await guard.beforeCreate?.(effectivePayload, trx);
		},
		async beforeDelete(keys, trx) {
			for (const guard of guards) await guard.beforeDelete?.(keys, trx);
		},
	};
}
