import type { SchemaOverview } from '@directus/types';
import type { Knex } from 'knex';
import getDatabase from '../database/index.js';
import logger from '../logger.js';
import { PermissionsService } from '../services/permissions.js';
import { RolesService } from '../services/roles.js';
import type { ConfigPermission, ConfigPermissionSet, ConfigRole, DirectusConfig } from '../types/config.js';
import { getSchema } from './get-schema.js';

function parseJSON(field: string, permId: unknown, value: unknown): Record<string, any> | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'object') return value as Record<string, any>;
	if (typeof value === 'string') {
		try {
			return JSON.parse(value);
		} catch {
			logger.warn(`Permission id=${permId}: failed to parse ${field} as JSON — treating as null.`);
			return null;
		}
	}

	return null;
}

function parseCSV(value: unknown): string[] | null {
	if (value === null || value === undefined) return null;

	let arr: string[];

	if (Array.isArray(value)) {
		arr = value;
	} else if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '') return null;
		arr = trimmed.split(',').map((s) => s.trim());
	} else {
		return null;
	}

	return [...arr].sort();
}

function sortStringArray(value: unknown): string[] | null {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) return [...value].sort();
	return null;
}

export async function getConfigSnapshot(options?: {
	database?: Knex;
	schema?: SchemaOverview;
}): Promise<DirectusConfig> {
	const database = options?.database ?? getDatabase();
	const schema = options?.schema ?? (await getSchema({ database, bypassCache: true }));

	const rolesService = new RolesService({ knex: database, schema });
	const permissionsService = new PermissionsService({ knex: database, schema });

	const rolesRaw = await rolesService.readByQuery({ limit: -1 });

	const roleKeyById = new Map<string, string>();
	const roles: ConfigRole[] = [];

	for (const role of rolesRaw) {
		roleKeyById.set(role['id'], role['key']);

		const configRole: ConfigRole = {
			key: role['key'],
			name: role['name'],
			admin_access: role['admin_access'],
			app_access: role['app_access'],
		};

		if (role['icon'] != null) configRole.icon = role['icon'];
		if (role['description'] != null) configRole.description = role['description'];
		if (role['enforce_tfa'] != null) configRole.enforce_tfa = role['enforce_tfa'];
		if (role['ip_access'] != null) configRole.ip_access = sortStringArray(role['ip_access']);

		roles.push(configRole);
	}

	const permissionsRaw = await permissionsService.readByQuery({ limit: -1 });

	const permissionsByRoleKey = new Map<string, ConfigPermission[]>();
	const seen = new Set<string>();
	let orphanedCount = 0;

	for (const perm of permissionsRaw) {
		if (perm['system'] === true) continue;

		const roleId = perm['role'];
		let roleKey: string;

		if (roleId === null) {
			roleKey = 'public';
		} else {
			const resolved = roleKeyById.get(roleId);

			if (!resolved) {
				orphanedCount++;
				logger.warn(`Permission id=${perm['id']} references non-existent role ${roleId} — skipped in snapshot.`);
				continue;
			}

			roleKey = resolved;
		}

		const tupleKey = `${roleKey}::${perm['collection']}::${perm['action']}`;

		if (seen.has(tupleKey)) {
			throw new Error(
				`Duplicate permission found: role="${roleKey}" collection="${perm['collection']}" action="${perm['action']}". ` +
					`Resolve duplicates in the admin UI or database before running config snapshot.`
			);
		}

		seen.add(tupleKey);

		if (!permissionsByRoleKey.has(roleKey)) {
			permissionsByRoleKey.set(roleKey, []);
		}

		permissionsByRoleKey.get(roleKey)!.push({
			collection: perm['collection'],
			action: perm['action'],
			permissions: parseJSON('permissions', perm['id'], perm['permissions']),
			validation: parseJSON('validation', perm['id'], perm['validation']),
			presets: parseJSON('presets', perm['id'], perm['presets']),
			fields: parseCSV(perm['fields']),
		});
	}

	if (orphanedCount > 0) {
		logger.warn(
			`Skipped ${orphanedCount} orphaned permission(s) referencing non-existent roles. ` +
				`This indicates database inconsistency or out-of-band modification. ` +
				`Clean up these rows directly in the database before relying on this snapshot as authoritative.`
		);
	}

	const permissions: ConfigPermissionSet[] = [];

	for (const [roleKey, perms] of permissionsByRoleKey) {
		perms.sort((a, b) => {
			const cmp = a.collection.localeCompare(b.collection);
			if (cmp !== 0) return cmp;
			return a.action.localeCompare(b.action);
		});

		permissions.push({ role: roleKey, permissions: perms });
	}

	permissions.sort((a, b) => a.role.localeCompare(b.role));
	roles.sort((a, b) => a.key.localeCompare(b.key));

	return {
		manifest: {
			version: 1,
			resources: ['roles', 'permissions'],
		},
		roles,
		permissions,
	};
}
