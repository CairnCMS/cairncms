import type { PermissionsAction, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import type {
	CairnConfig,
	ConfigPlan,
	ConfigPlanEnrichment,
	ConfigPlanWarning,
	PermissionIdentity,
	RoleDeletionImpactEntry,
} from '../types/config.js';
import { SUPPORTED_ACTIONS } from './config-contract.js';
import { safeLogFragment } from './safe-log-fragment.js';

type EnrichOptions = {
	schema: SchemaOverview;
	database: Knex;
};

type RoleImpact = {
	permissions: PermissionIdentity[];
	presetCount: number;
	bookmarks: string[];
	users: string[];
	sessions: number;
};

export async function enrichConfigPlan(
	plan: ConfigPlan,
	desired: CairnConfig,
	options: EnrichOptions
): Promise<ConfigPlanEnrichment> {
	const roleDeletionImpact = await readRoleDeletionImpact(plan.roles.delete, options.database);
	const warnings = collectMissingCollectionWarnings(desired, options.schema);

	return { roleDeletionImpact, warnings };
}

function readFailure(subject: string): ConfigReadFailedException {
	return new ConfigReadFailedException(`Config plan could not read ${subject}. Restore database access, then retry.`);
}

function inconsistentImpact(detail: string): ConfigReadFailedException {
	return new ConfigReadFailedException(
		`Config plan could not compute deletion impact: ${detail}. Restore database consistency, then retry.`
	);
}

async function readImpact<T>(subject: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (err instanceof ConfigReadFailedException) throw err;
		throw readFailure(subject);
	}
}

async function readRoleDeletionImpact(
	deletedKeys: string[],
	database: Knex
): Promise<Map<string, RoleDeletionImpactEntry[]>> {
	if (deletedKeys.length === 0) return new Map();

	const roleRows = await readImpact('the roles being deleted', () =>
		database('directus_roles').select('id', 'key').whereIn('key', deletedKeys)
	);

	const idByKey = new Map<string, string>();

	for (const row of roleRows) {
		const key = row['key'];
		const id = row['id'];

		if (typeof key !== 'string' || key === '' || typeof id !== 'string' || id === '') {
			throw inconsistentImpact('a role row is missing a usable id or key');
		}

		if (idByKey.has(key)) {
			throw inconsistentImpact(`role key "${safeLogFragment(key)}" matches more than one row`);
		}

		idByKey.set(key, id);
	}

	for (const key of deletedKeys) {
		if (!idByKey.has(key)) {
			throw inconsistentImpact(
				`role "${safeLogFragment(key)}" no longer exists, so its deletion impact cannot be read`
			);
		}
	}

	const keyById = new Map<string, string>();
	for (const [key, id] of idByKey) keyById.set(id, key);

	const roleIds = [...idByKey.values()];

	const impact = new Map<string, RoleImpact>();

	for (const key of deletedKeys) {
		impact.set(key, { permissions: [], presetCount: 0, bookmarks: [], users: [], sessions: 0 });
	}

	const permissionRows = await readImpact('permissions cascaded by a role deletion', () =>
		database('directus_permissions').select('role', 'collection', 'action').whereIn('role', roleIds)
	);

	for (const row of permissionRows) {
		const key = resolveRoleKey(keyById, row['role'], 'a cascaded permission');
		const collection = row['collection'];

		if (typeof collection !== 'string' || collection === '') {
			throw inconsistentImpact(`a cascaded permission for role "${safeLogFragment(key)}" has no collection`);
		}

		const action = row['action'];

		if (typeof action !== 'string' || !SUPPORTED_ACTIONS.has(action)) {
			throw inconsistentImpact(
				`a cascaded permission for role "${safeLogFragment(key)}" has unsupported action "${safeLogFragment(action)}"`
			);
		}

		impact.get(key)!.permissions.push({ role: key, collection, action: action as PermissionsAction });
	}

	const presetRows = await readImpact('presets cascaded by a role deletion', () =>
		database('directus_presets').select('role', 'bookmark').whereIn('role', roleIds)
	);

	for (const row of presetRows) {
		const key = resolveRoleKey(keyById, row['role'], 'a cascaded preset');
		const entry = impact.get(key)!;

		entry.presetCount++;

		const bookmark = row['bookmark'];

		if (typeof bookmark === 'string') {
			entry.bookmarks.push(bookmark);
		} else if (bookmark !== null) {
			throw inconsistentImpact(`a cascaded preset for role "${safeLogFragment(key)}" has an unreadable bookmark`);
		}
	}

	const userRows = await readImpact('users affected by a role deletion', () =>
		database('directus_users').select('id', 'role').whereIn('role', roleIds)
	);

	const roleKeyByUserId = new Map<string, string>();

	for (const row of userRows) {
		const key = resolveRoleKey(keyById, row['role'], 'an affected user');
		const userId = row['id'];

		if (typeof userId !== 'string' || userId === '') {
			throw inconsistentImpact(`an affected user for role "${safeLogFragment(key)}" has no id`);
		}

		impact.get(key)!.users.push(userId);
		roleKeyByUserId.set(userId, key);
	}

	const userIds = [...roleKeyByUserId.keys()];

	if (userIds.length > 0) {
		const now = new Date();

		const sessionRows = await readImpact('sessions affected by a role deletion', () =>
			database('directus_sessions').select('user', 'expires').whereIn('user', userIds).where('expires', '>=', now)
		);

		for (const row of sessionRows) {
			const userId = row['user'];
			const key = typeof userId === 'string' ? roleKeyByUserId.get(userId) : undefined;

			if (!key) {
				throw inconsistentImpact(`a session references user ${safeLogFragment(userId)}, who is not an affected user`);
			}

			const expiresAt = new Date(row['expires']).getTime();

			if (Number.isNaN(expiresAt)) {
				throw inconsistentImpact(`a session for an affected user has an unreadable expiry`);
			}

			if (expiresAt < now.getTime()) continue;

			impact.get(key)!.sessions++;
		}
	}

	const result = new Map<string, RoleDeletionImpactEntry[]>();

	for (const [key, accumulated] of impact) {
		result.set(key, toImpactEntries(accumulated));
	}

	return result;
}

function resolveRoleKey(keyById: Map<string, string>, roleId: unknown, subject: string): string {
	const key = typeof roleId === 'string' ? keyById.get(roleId) : undefined;

	if (!key) {
		throw inconsistentImpact(`${subject} references role id ${safeLogFragment(roleId)}, which is not being deleted`);
	}

	return key;
}

function toImpactEntries(accumulated: RoleImpact): RoleDeletionImpactEntry[] {
	const permissions = [...accumulated.permissions].sort((a, b) => {
		const byCollection = a.collection.localeCompare(b.collection);
		if (byCollection !== 0) return byCollection;
		return a.action.localeCompare(b.action);
	});

	const entries: RoleDeletionImpactEntry[] = permissions.map((identity) => ({ kind: 'permissions', identity }));

	entries.push({ kind: 'presets', count: accumulated.presetCount, bookmarks: [...accumulated.bookmarks].sort() });
	entries.push({ kind: 'users', suspended: [...accumulated.users].sort() });
	entries.push({ kind: 'sessions', active: accumulated.sessions });

	return entries;
}

function collectMissingCollectionWarnings(desired: CairnConfig, schema: SchemaOverview): ConfigPlanWarning[] {
	if (!desired.manifest.resources.includes('permissions')) return [];

	const warnings: ConfigPlanWarning[] = [];

	for (const set of desired.permissions) {
		for (const permission of set.permissions) {
			if (Object.hasOwn(schema.collections, permission.collection)) continue;

			warnings.push({
				code: 'COLLECTION_MISSING',
				kind: 'permissions',
				identity: { role: set.role, collection: permission.collection, action: permission.action },
				message: `Permission for role "${set.role}" targets collection "${permission.collection}", which does not exist in the schema.`,
			});
		}
	}

	warnings.sort((a, b) => {
		const byRole = a.identity.role.localeCompare(b.identity.role);
		if (byRole !== 0) return byRole;
		const byCollection = a.identity.collection.localeCompare(b.identity.collection);
		if (byCollection !== 0) return byCollection;
		return a.identity.action.localeCompare(b.identity.action);
	});

	return warnings;
}
