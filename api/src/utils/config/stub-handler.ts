import type { ConfigKindTypes, ConfigResourceHandler } from './descriptor.js';

/**
 * A handler whose operations throw. Used where only a descriptor's declarative parts (schema, identity,
 * composition) are needed and the domain-service operations are not.
 */
export function createUnwiredHandler<K extends ConfigKindTypes>(): ConfigResourceHandler<K> {
	const unwired = (): never => {
		throw new Error('config resource handler operation is not available');
	};

	return {
		readCurrent: unwired,
		validateDesired: unwired,
		postPlan: unwired,
		enrich: unwired,
		emptyEnrichment: unwired,
		toChanges: unwired,
		applyCreates: unwired,
		applyUpdates: unwired,
		applyDeletes: unwired,
		readApplyDependencyState: unwired,
		emptyResult: unwired,
		mergeOutcome: unwired,
	};
}
