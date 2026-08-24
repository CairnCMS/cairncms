import type { CairnConfig, ConfigFailure, ConfigKind, ConfigPlan } from '../types/config.js';
import { makeDependencyAccessor } from './config/dependency-context.js';
import { computeKindPlan } from './config/diff.js';
import { dependencyClosure, dependencyOrder } from './config/graph.js';
import { getDescriptor, listConfigKinds } from './config/registry.js';

function emptyKindPlan(): { create: never[]; update: never[]; delete: never[] } {
	return { create: [], update: [], delete: [] };
}

export function computeConfigPlan(current: CairnConfig, desired: CairnConfig): ConfigPlan {
	const managed = new Set<ConfigKind>(desired.manifest.resources);
	const closure = dependencyOrder([...dependencyClosure([...managed], (kind) => getDescriptor(kind).dependencies)]);
	const published = new Map<ConfigKind, unknown>();

	for (const kind of closure) {
		if (!managed.has(kind)) {
			published.set(kind, emptyKindPlan());
			continue;
		}

		const descriptor = getDescriptor(kind);
		const currentRecords = descriptor.projectDocuments(current[kind] as never).records;
		const desiredRecords = descriptor.projectDocuments(desired[kind] as never).records;
		const raw = computeKindPlan(descriptor as never, currentRecords as never, desiredRecords as never);

		const context = { dependency: makeDependencyAccessor(descriptor.dependencies, published) };
		published.set(kind, descriptor.handler.postPlan(raw as never, context as never));
	}

	return Object.fromEntries(
		listConfigKinds().map((kind) => [kind, published.get(kind) ?? emptyKindPlan()])
	) as unknown as ConfigPlan;
}

export function validateConfigPlan(
	plan: ConfigPlan,
	desired: CairnConfig,
	context: { currentRoles: Map<string, { admin_access: boolean }> }
): ConfigFailure[] {
	const failures: ConfigFailure[] = [];

	if (plan.roles.delete.length > 0) {
		const deletedKeys = new Set(plan.roles.delete);

		const remainingAdminCount = [...context.currentRoles.entries()].filter(([key, role]) => {
			if (deletedKeys.has(key)) return false;
			return role.admin_access;
		}).length;

		const desiredAdminCount = desired.roles.filter((r) => {
			if (deletedKeys.has(r.key)) return false;
			return r.admin_access;
		}).length;

		if (remainingAdminCount + desiredAdminCount === 0) {
			failures.push({ code: 'CONFIG_PROTECTED_RECORD', message: 'Cannot delete the last admin role.' });
		}
	}

	return failures;
}
