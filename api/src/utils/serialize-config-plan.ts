import type {
	ConfigPlan,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigPlanWarning,
	SerializedConfigPlan,
} from '../types/config.js';
import type { ConfigKind } from '../types/config.js';
import { compareCodeUnits } from './config/canonical-encode.js';
import { dependencyOrder } from './config/graph.js';
import { comparePermissionIdentity } from './config/identity-order.js';
import { getDescriptor, listConfigKinds } from './config/registry.js';

const KIND_RANK = new Map(dependencyOrder(listConfigKinds()).map((kind, index) => [kind, index]));
const OPERATION_RANK = { create: 0, update: 1, delete: 2 } as const;

function rankOf(kind: ConfigKind): number {
	const rank = KIND_RANK.get(kind);
	if (rank === undefined) throw new Error(`Config kind "${kind}" has no serialization rank.`);
	return rank;
}

export function serializeConfigPlan(
	plan: ConfigPlan,
	options: { enrichment: ConfigPlanEnrichment; manifestVersion: number }
): SerializedConfigPlan {
	const changes: ConfigPlanChange[] = [];

	for (const kind of listConfigKinds()) {
		changes.push(...getDescriptor(kind).handler.toChanges(plan[kind] as never, options.enrichment));
	}

	changes.sort(compareChanges);

	const summary = {
		create: changes.filter((change) => change.operation === 'create').length,
		update: changes.filter((change) => change.operation === 'update').length,
		delete: changes.filter((change) => change.operation === 'delete').length,
	};

	const warnings = [...options.enrichment.warnings].sort(compareWarnings);

	return {
		planVersion: plan.managedResources.includes('schema') ? 3 : 2,
		manifestVersion: options.manifestVersion,
		changes,
		summary,
		warnings,
		protections: plan.protections,
	};
}

const SCHEMA_CHANGE_RANK = { collections: 0, fields: 1, relations: 2 } as const;

type SchemaChange = Extract<ConfigPlanChange, { kind: 'collections' | 'fields' | 'relations' }>;

function isSchemaChange(change: ConfigPlanChange): change is SchemaChange {
	return change.kind === 'collections' || change.kind === 'fields' || change.kind === 'relations';
}

/** Schema changes carry their own kinds, so they rank at the schema resource's position and order within it. */
function changeResource(change: ConfigPlanChange): ConfigKind {
	return isSchemaChange(change) ? 'schema' : change.kind;
}

function compareSchemaIdentity(a: SchemaChange, b: SchemaChange): number {
	const byCollection = compareCodeUnits(a.identity.collection, b.identity.collection);
	if (byCollection !== 0) return byCollection;

	const aField = 'field' in a.identity ? a.identity.field : '';
	const bField = 'field' in b.identity ? b.identity.field : '';
	return compareCodeUnits(aField, bField);
}

function compareChanges(a: ConfigPlanChange, b: ConfigPlanChange): number {
	const byKind = rankOf(changeResource(a)) - rankOf(changeResource(b));
	if (byKind !== 0) return byKind;

	if (isSchemaChange(a) || isSchemaChange(b)) {
		// Equal resource rank means both are schema changes; the mixed branch is unreachable.
		if (isSchemaChange(a) && isSchemaChange(b)) {
			const bySubKind = SCHEMA_CHANGE_RANK[a.kind] - SCHEMA_CHANGE_RANK[b.kind];
			if (bySubKind !== 0) return bySubKind;

			const byOperation = OPERATION_RANK[a.operation] - OPERATION_RANK[b.operation];
			if (byOperation !== 0) return byOperation;

			return compareSchemaIdentity(a, b);
		}

		return 0;
	}

	const byOperation = OPERATION_RANK[a.operation] - OPERATION_RANK[b.operation];
	if (byOperation !== 0) return byOperation;

	return getDescriptor(a.kind).compareIdentity(a.identity as never, b.identity as never);
}

function compareWarnings(a: ConfigPlanWarning, b: ConfigPlanWarning): number {
	return comparePermissionIdentity(a.identity, b.identity);
}
