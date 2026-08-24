import type {
	ConfigPlan,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigPlanWarning,
	SerializedConfigPlan,
} from '../types/config.js';
import type { ConfigKind } from '../types/config.js';
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

	return { planVersion: 1, manifestVersion: options.manifestVersion, changes, summary, warnings };
}

function compareChanges(a: ConfigPlanChange, b: ConfigPlanChange): number {
	const byKind = rankOf(a.kind) - rankOf(b.kind);
	if (byKind !== 0) return byKind;

	const byOperation = OPERATION_RANK[a.operation] - OPERATION_RANK[b.operation];
	if (byOperation !== 0) return byOperation;

	return getDescriptor(a.kind).compareIdentity(a.identity as never, b.identity as never);
}

function compareWarnings(a: ConfigPlanWarning, b: ConfigPlanWarning): number {
	return comparePermissionIdentity(a.identity, b.identity);
}
