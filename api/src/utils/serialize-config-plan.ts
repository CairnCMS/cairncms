import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import type {
	ConfigPermission,
	ConfigPlan,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigPlanWarning,
	PermissionIdentity,
	RoleDeletionImpactEntry,
	SerializedConfigPlan,
} from '../types/config.js';
import { canonicalizePermission, canonicalizeRole } from './canonicalize-config-record.js';
import { safeLogFragment } from './safe-log-fragment.js';

const KIND_RANK = { roles: 0, permissions: 1 } as const;
const OPERATION_RANK = { create: 0, update: 1, delete: 2 } as const;

export function serializeConfigPlan(
	plan: ConfigPlan,
	options: { enrichment: ConfigPlanEnrichment; manifestVersion: number }
): SerializedConfigPlan {
	const changes: ConfigPlanChange[] = [];

	for (const role of plan.roles.create) {
		changes.push({ kind: 'roles', operation: 'create', identity: { key: role.key }, values: canonicalizeRole(role) });
	}

	for (const update of plan.roles.update) {
		changes.push({ kind: 'roles', operation: 'update', identity: { key: update.key }, fields: update.changes });
	}

	for (const key of plan.roles.delete) {
		const impact = options.enrichment.roleDeletionImpact.get(key);

		if (!impact) {
			throw incompleteImpact(key, 'no impact was computed');
		}

		changes.push({ kind: 'roles', operation: 'delete', identity: { key }, impact: normalizeImpact(key, impact) });
	}

	for (const create of plan.permissions.create) {
		changes.push({
			kind: 'permissions',
			operation: 'create',
			identity: permissionIdentity(create.roleKey, create.permission),
			values: canonicalizePermission(create.permission),
		});
	}

	for (const update of plan.permissions.update) {
		changes.push({
			kind: 'permissions',
			operation: 'update',
			identity: { role: update.roleKey, collection: update.collection, action: update.action },
			fields: update.changes,
		});
	}

	for (const del of plan.permissions.delete) {
		changes.push({
			kind: 'permissions',
			operation: 'delete',
			identity: { role: del.roleKey, collection: del.collection, action: del.action },
			impact: [],
		});
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

function normalizeImpact(key: string, entries: RoleDeletionImpactEntry[]): RoleDeletionImpactEntry[] {
	const permissions = entries
		.filter((entry): entry is Extract<RoleDeletionImpactEntry, { kind: 'permissions' }> => entry.kind === 'permissions')
		.sort((a, b) => comparePermissionIdentity(a.identity, b.identity));

	const presets = requireOneAggregate(key, entries, 'presets');
	const users = requireOneAggregate(key, entries, 'users');
	const sessions = requireOneAggregate(key, entries, 'sessions');

	return [
		...permissions,
		{ kind: 'presets', count: presets.count, bookmarks: [...presets.bookmarks].sort() },
		{ kind: 'users', suspended: [...users.suspended].sort() },
		{ kind: 'sessions', active: sessions.active },
	];
}

function requireOneAggregate<K extends 'presets' | 'users' | 'sessions'>(
	key: string,
	entries: RoleDeletionImpactEntry[],
	kind: K
): Extract<RoleDeletionImpactEntry, { kind: K }> {
	const matches = entries.filter(
		(entry): entry is Extract<RoleDeletionImpactEntry, { kind: K }> => entry.kind === kind
	);

	if (matches.length !== 1) {
		throw incompleteImpact(key, `expected exactly one ${kind} entry, found ${matches.length}`);
	}

	return matches[0]!;
}

function incompleteImpact(key: string, detail: string): ConfigReadFailedException {
	return new ConfigReadFailedException(
		`Config plan produced incomplete deletion impact for role "${safeLogFragment(
			key
		)}": ${detail}. Retry the operation and report the failure if it persists.`
	);
}

function permissionIdentity(roleKey: string, permission: ConfigPermission): PermissionIdentity {
	return { role: roleKey, collection: permission.collection, action: permission.action };
}

function comparePermissionIdentity(a: PermissionIdentity, b: PermissionIdentity): number {
	const byRole = a.role.localeCompare(b.role);
	if (byRole !== 0) return byRole;

	const byCollection = a.collection.localeCompare(b.collection);
	if (byCollection !== 0) return byCollection;

	return a.action.localeCompare(b.action);
}

function compareChanges(a: ConfigPlanChange, b: ConfigPlanChange): number {
	const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
	if (byKind !== 0) return byKind;

	const byOperation = OPERATION_RANK[a.operation] - OPERATION_RANK[b.operation];
	if (byOperation !== 0) return byOperation;

	if (a.kind === 'roles' && b.kind === 'roles') {
		return a.identity.key.localeCompare(b.identity.key);
	}

	if (a.kind === 'permissions' && b.kind === 'permissions') {
		return comparePermissionIdentity(a.identity, b.identity);
	}

	return 0;
}

function compareWarnings(a: ConfigPlanWarning, b: ConfigPlanWarning): number {
	return comparePermissionIdentity(a.identity, b.identity);
}
