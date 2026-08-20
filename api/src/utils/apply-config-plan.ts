import { BaseException } from '@cairncms/exceptions';
import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { clearSystemCache } from '../cache.js';
import getDatabase from '../database/index.js';
import { ConfigApplyFailedException } from '../exceptions/config-apply-failed.js';
import { DestructiveChangesRequiredException } from '../exceptions/destructive-changes-required.js';
import { PermissionsService } from '../services/permissions.js';
import { RolesService } from '../services/roles.js';
import type {
	ApplyResult,
	ConfigPlan,
	PermissionFieldChanges,
	PermissionIdentity,
	PermissionValues,
	RoleFieldChanges,
	RoleIdentity,
	RoleValues,
} from '../types/config.js';
import { canonicalizePermission, canonicalizeRole } from './canonicalize-config-record.js';
import { getSchema } from './get-schema.js';

type PlanDeletion = { kind: 'roles'; identity: RoleIdentity } | { kind: 'permissions'; identity: PermissionIdentity };

export function planHasDeletions(plan: ConfigPlan): boolean {
	return plan.roles.delete.length > 0 || plan.permissions.delete.length > 0;
}

export function planDeletions(plan: ConfigPlan): PlanDeletion[] {
	return [
		...plan.roles.delete.map((key): PlanDeletion => ({ kind: 'roles', identity: { key } })),
		...plan.permissions.delete.map(
			(entry): PlanDeletion => ({
				kind: 'permissions',
				identity: { role: entry.roleKey, collection: entry.collection, action: entry.action },
			})
		),
	];
}

function roleUpdateValues(changes: RoleFieldChanges): Partial<RoleValues> {
	const values: Partial<RoleValues> = {};

	if (changes.name) values.name = changes.name.after;
	if (changes.icon) values.icon = changes.icon.after;
	if (changes.description) values.description = changes.description.after;
	if (changes.admin_access) values.admin_access = changes.admin_access.after;
	if (changes.app_access) values.app_access = changes.app_access.after;
	if (changes.enforce_tfa) values.enforce_tfa = changes.enforce_tfa.after;
	if (changes.ip_access) values.ip_access = changes.ip_access.after;

	return values;
}

function permissionUpdateValues(changes: PermissionFieldChanges): Partial<PermissionValues> {
	const values: Partial<PermissionValues> = {};

	if (changes.permissions) values.permissions = changes.permissions.after;
	if (changes.validation) values.validation = changes.validation.after;
	if (changes.presets) values.presets = changes.presets.after;
	if (changes.fields) values.fields = changes.fields.after;

	return values;
}

export async function applyConfigPlan(
	plan: ConfigPlan,
	opts: {
		database?: Knex;
		schema?: SchemaOverview;
		destructive?: boolean;
	}
): Promise<ApplyResult> {
	const result: ApplyResult = {
		roles: { created: [], updated: [], deleted: [] },
		permissions: { created: 0, updated: 0, deleted: 0 },
	};

	const isEmpty =
		plan.roles.create.length === 0 &&
		plan.roles.update.length === 0 &&
		plan.roles.delete.length === 0 &&
		plan.permissions.create.length === 0 &&
		plan.permissions.update.length === 0 &&
		plan.permissions.delete.length === 0;

	if (isEmpty) return result;

	if (!opts.destructive && planHasDeletions(plan)) {
		throw new DestructiveChangesRequiredException(
			'The configuration plan contains deletions. Re-run with the destructive option to authorize them.',
			{ deletions: planDeletions(plan) }
		);
	}

	const database = opts.database ?? getDatabase();
	const schema = opts.schema ?? (await getSchema({ database, bypassCache: true }));

	await database.transaction(async (trx) => {
		try {
			const rolesService = new RolesService({ knex: trx, schema });
			const permissionsService = new PermissionsService({ knex: trx, schema });
			const skipCache = { autoPurgeCache: false as const };

			for (const role of plan.roles.create) {
				await rolesService.createOne({ key: role.key, ...canonicalizeRole(role) });

				result.roles.created.push(role.key);
			}

			for (const { key, changes } of plan.roles.update) {
				const existing = await trx('directus_roles').select('id').where({ key }).first();
				if (!existing) throw new Error(`Role "${key}" not found during apply.`);

				await rolesService.updateOne(existing.id, roleUpdateValues(changes));
				result.roles.updated.push(key);
			}

			const allRoles = await trx('directus_roles').select('id', 'key');
			const roleIdByKey = new Map<string, string>();

			for (const row of allRoles) {
				roleIdByKey.set(row.key, row.id);
			}

			// `roleIdByKey` includes the sentinel (key='public'), so 'public' resolves with no special case.
			for (const { roleKey, permission } of plan.permissions.create) {
				const roleId = roleIdByKey.get(roleKey);

				if (roleId === undefined) {
					throw new Error(`Cannot create permission: role "${roleKey}" not found.`);
				}

				await permissionsService.createOne(
					{
						role: roleId,
						collection: permission.collection,
						action: permission.action,
						...canonicalizePermission(permission),
					},
					skipCache
				);

				result.permissions.created++;
			}

			for (const { roleKey, collection, action, changes } of plan.permissions.update) {
				const roleId = roleIdByKey.get(roleKey);

				if (roleId === undefined) {
					throw new Error(`Cannot update permission: role "${roleKey}" not found.`);
				}

				const existing = await trx('directus_permissions')
					.select('id')
					.where({ collection, action, role: roleId })
					.first();

				if (existing === undefined) {
					throw new Error(
						`Permission not found for update: role="${roleKey}" collection="${collection}" action="${action}".`
					);
				}

				await permissionsService.updateOne(existing['id'], permissionUpdateValues(changes), skipCache);

				result.permissions.updated++;
			}

			for (const key of plan.roles.delete) {
				const existing = await trx('directus_roles').select('id').where({ key }).first();

				if (existing) {
					await rolesService.deleteOne(existing.id);
					result.roles.deleted.push(key);
				}
			}

			for (const { roleKey, collection, action } of plan.permissions.delete) {
				// A deleted role's permissions go with it through the RolesService cascade, so skip them here.
				if (plan.roles.delete.includes(roleKey)) continue;

				const roleId = roleIdByKey.get(roleKey);

				if (roleId === undefined) continue;

				const existing = await trx('directus_permissions')
					.select('id')
					.where({ collection, action, role: roleId })
					.first();

				if (existing !== undefined) {
					await permissionsService.deleteOne(existing['id'], skipCache);
					result.permissions.deleted++;
				}
			}
		} catch (err) {
			if (err instanceof BaseException) throw err;
			throw new ConfigApplyFailedException();
		}
	});

	await clearSystemCache();

	return result;
}
