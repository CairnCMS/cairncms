import type { SchemaOverview } from '@directus/types';
import type { Knex } from 'knex';
import { clearSystemCache } from '../cache.js';
import getDatabase from '../database/index.js';
import { PermissionsService } from '../services/permissions.js';
import { RolesService } from '../services/roles.js';
import type { ApplyResult, ConfigPlan } from '../types/config.js';
import { getSchema } from './get-schema.js';

export async function applyConfigPlan(
	plan: ConfigPlan,
	opts: {
		database?: Knex;
		schema?: SchemaOverview;
		destructive?: boolean;
		dryRun?: boolean;
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

	if (opts.dryRun) {
		result.roles.created = plan.roles.create.map((r) => r.key);
		result.roles.updated = plan.roles.update.map((r) => r.key);

		if (opts.destructive) {
			result.roles.deleted = [...plan.roles.delete];
			const deletedRoleKeys = new Set(plan.roles.delete);
			result.permissions.deleted = plan.permissions.delete.filter(
				(d) => !deletedRoleKeys.has(d.roleKey)
			).length;
		}

		result.permissions.created = plan.permissions.create.length;
		result.permissions.updated = plan.permissions.update.length;

		return result;
	}

	const database = opts.database ?? getDatabase();
	const schema = opts.schema ?? (await getSchema({ database, bypassCache: true }));

	await database.transaction(async (trx) => {
		const rolesService = new RolesService({ knex: trx, schema });
		const permissionsService = new PermissionsService({ knex: trx, schema });
		const skipCache = { autoPurgeCache: false as const };

		// Step 1: create and update roles
		for (const role of plan.roles.create) {
			await rolesService.createOne({
				name: role.name,
				key: role.key,
				icon: role.icon ?? 'supervised_user_circle',
				description: role.description ?? null,
				admin_access: role.admin_access,
				app_access: role.app_access,
				enforce_tfa: role.enforce_tfa ?? false,
				ip_access: role.ip_access ?? null,
			});

			result.roles.created.push(role.key);
		}

		for (const { key, diff } of plan.roles.update) {
			const existing = await trx('directus_roles').select('id').where({ key }).first();
			if (!existing) throw new Error(`Role "${key}" not found during apply.`);

			await rolesService.updateOne(existing.id, diff);
			result.roles.updated.push(key);
		}

		// Step 2: rebuild key → id map from transactional state
		const allRoles = await trx('directus_roles').select('id', 'key');
		const roleIdByKey = new Map<string, string>();

		for (const row of allRoles) {
			roleIdByKey.set(row.key, row.id);
		}

		// Step 3: create and update permissions
		for (const { roleKey, permission } of plan.permissions.create) {
			const roleId = roleKey === 'public' ? null : roleIdByKey.get(roleKey);

			if (roleId === undefined) {
				throw new Error(`Cannot create permission: role "${roleKey}" not found.`);
			}

			await permissionsService.createOne({
				role: roleId,
				collection: permission.collection,
				action: permission.action,
				permissions: permission.permissions,
				validation: permission.validation,
				presets: permission.presets,
				fields: permission.fields,
			}, skipCache);

			result.permissions.created++;
		}

		for (const { roleKey, permission } of plan.permissions.update) {
			const roleId = roleKey === 'public' ? null : roleIdByKey.get(roleKey);

			if (roleId === undefined) {
				throw new Error(`Cannot update permission: role "${roleKey}" not found.`);
			}

			const filter: Record<string, any> = {
				collection: { _eq: permission.collection },
				action: { _eq: permission.action },
			};

			if (roleId === null) {
				filter['role'] = { _null: true };
			} else {
				filter['role'] = { _eq: roleId };
			}

			const existing = await permissionsService.readByQuery({
				filter,
				limit: 1,
			});

			if (existing.length === 0) {
				throw new Error(
					`Permission not found for update: role="${roleKey}" collection="${permission.collection}" action="${permission.action}".`
				);
			}

			await permissionsService.updateOne(existing[0]!['id'], {
				permissions: permission.permissions,
				validation: permission.validation,
				presets: permission.presets,
				fields: permission.fields,
			}, skipCache);

			result.permissions.updated++;
		}

		// Step 4: destructive role deletions
		if (opts.destructive) {
			for (const key of plan.roles.delete) {
				const existing = await trx('directus_roles').select('id').where({ key }).first();

				if (existing) {
					await rolesService.deleteOne(existing.id);
					result.roles.deleted.push(key);
				}
			}
		}

		// Step 5: destructive permission deletions (for kept roles only)
		if (opts.destructive) {
			for (const { roleKey, collection, action } of plan.permissions.delete) {
				if (plan.roles.delete.includes(roleKey)) continue;

				const roleId = roleKey === 'public' ? null : roleIdByKey.get(roleKey);

				if (roleId === undefined) continue;

				const filter: Record<string, any> = {
					collection: { _eq: collection },
					action: { _eq: action },
				};

				if (roleId === null) {
					filter['role'] = { _null: true };
				} else {
					filter['role'] = { _eq: roleId };
				}

				const existing = await permissionsService.readByQuery({
					filter,
					limit: 1,
				});

				if (existing.length > 0) {
					await permissionsService.deleteOne(existing[0]!['id'], skipCache);
					result.permissions.deleted++;
				}
			}
		}
	});

	await clearSystemCache();

	return result;
}
