import type { CairnConfig, ConfigKind, ConfigPlan, ConfigProtection, ProtectionContributor } from '../types/config.js';
import { leavesAtLeastOneAdmin } from './admin-continuity.js';
import { makeDependencyAccessor } from './config/dependency-context.js';
import { computeKindPlan } from './config/diff.js';
import { dependencyClosure, dependencyOrder } from './config/graph.js';
import { getDescriptor, listConfigKinds } from './config/registry.js';

const ADMIN_CONTINUITY_MESSAGE = 'Configuration must retain at least one role with administrator access.';

const EMPTY: ReadonlySet<string> = new Set();

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

	const slices = Object.fromEntries(
		listConfigKinds().map((kind) => [kind, published.get(kind) ?? emptyKindPlan()])
	) as unknown as Pick<ConfigPlan, ConfigKind>;

	const protections = computeAdminContinuityProtections(current, slices, managed);
	const managedResources = Object.freeze([...managed].sort());

	return { ...slices, managedResources, protections };
}

/**
 * Simulates the apply sequence (create phase, then updates in executable array
 * order, then deletes) and its per-operation administrator-continuity check, so a
 * protected plan is refused before it can fail partway through apply. The walk order
 * and the per-operation enforcement are the hidden invariant this depends on. Gated
 * on roles being managed so it never reads unmanaged role documents.
 */
function computeAdminContinuityProtections(
	current: CairnConfig,
	plan: Pick<ConfigPlan, ConfigKind>,
	managed: Set<ConfigKind>
): ConfigProtection[] {
	if (!managed.has('roles')) return [];

	const admins = new Set<string>();

	for (const role of current.roles) {
		if (role?.admin_access) admins.add(role.key);
	}

	for (const created of plan.roles.create) {
		if (created.admin_access) admins.add(created.key);
	}

	const removals: ProtectionContributor[] = [];

	for (const update of plan.roles.update) {
		const change = update.changes.admin_access;
		if (change === undefined) continue;

		if (change.before === false && change.after === true) {
			admins.add(update.key);
			continue;
		}

		if (change.before === true && change.after === false) {
			removals.push({ kind: 'roles', operation: 'update', identity: { key: update.key } });

			if (!leavesAtLeastOneAdmin({ currentAdmins: admins, removing: new Set([update.key]), adding: EMPTY })) {
				return [protection(removals)];
			}

			admins.delete(update.key);
		}
	}

	for (const key of plan.roles.delete) {
		if (!admins.has(key)) continue;

		removals.push({ kind: 'roles', operation: 'delete', identity: { key } });

		if (!leavesAtLeastOneAdmin({ currentAdmins: admins, removing: new Set([key]), adding: EMPTY })) {
			return [protection(removals)];
		}

		admins.delete(key);
	}

	return [];
}

function protection(contributors: ProtectionContributor[]): ConfigProtection {
	return { code: 'ADMIN_CONTINUITY_REQUIRED', message: ADMIN_CONTINUITY_MESSAGE, contributors: [...contributors] };
}
