import { PUBLIC_ROLE_ID } from '@cairncms/constants';
import type { PermissionsAction, SchemaOverview } from '@cairncms/types';
import { normalizeRoleKey } from '@cairncms/utils';
import type { Knex } from 'knex';
import getDatabase from '../database/index.js';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import logger from '../logger.js';
import { PermissionsService } from '../services/permissions.js';
import { RolesService } from '../services/roles.js';
import type { CairnConfig, ConfigPermission, ConfigPermissionSet, ConfigRole } from '../types/config.js';
import { assertConfigValueSafe } from './parse-config-document.js';
import { getSchema } from './get-schema.js';
import { safeLogFragment } from './safe-log-fragment.js';

/**
 * Every action the permission contract defines. `satisfies` makes the union exhaustive, so adding a
 * member to `PermissionsAction` fails the build here rather than silently rejecting stored rows.
 */
const SUPPORTED_ACTIONS = new Set(
	Object.keys({
		create: true,
		read: true,
		update: true,
		delete: true,
		comment: true,
		explain: true,
		share: true,
	} satisfies Record<PermissionsAction, true>)
);

/** Reads never emit query filters, read filters, or read actions, so a hook cannot shape or observe them. */
const UNFILTERED = { emitEvents: false } as const;

function unreadable(subject: string, detail: string): ConfigReadFailedException {
	return new ConfigReadFailedException(`Config snapshot could not read ${subject}: ${detail}.`);
}

/**
 * A policy value that normalizes to null is absent. Every other stored value must be an object the
 * engine can round-trip, so anything else aborts rather than exporting as absent or as a foreign shape.
 */
function parseStoredJSON(field: string, permId: unknown, value: unknown): Record<string, any> | null {
	const subject = `permission id=${safeLogFragment(permId)}`;

	if (value === null) return null;

	if (value === undefined) {
		throw unreadable(subject, `column "${field}" was absent from the row, so the read is incomplete`);
	}

	let parsed: unknown = value;

	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			throw unreadable(subject, `column "${field}" does not hold valid JSON`);
		}
	}

	if (parsed === null) return null;

	if (Array.isArray(parsed) || typeof parsed !== 'object') {
		throw unreadable(
			subject,
			`column "${field}" holds a ${Array.isArray(parsed) ? 'array' : typeof parsed} where an object belongs`
		);
	}

	// A stored value the engine cannot round-trip is a current-state failure, not bad caller input, so the
	// parser's 400 is remapped while keeping its diagnostic, which already names the row, path, and reason.
	try {
		assertConfigValueSafe(parsed, `${subject} ${field}`);
	} catch (err) {
		if (err instanceof ConfigInvalidException) throw new ConfigReadFailedException(err.message);
		throw err;
	}

	return parsed as Record<string, any>;
}

/** Field lists are stored as a comma-separated string on some vendors and a native array on others. */
function parseStoredCSV(permId: unknown, value: unknown): string[] | null {
	const subject = `permission id=${safeLogFragment(permId)}`;

	if (value === null) return null;

	if (value === undefined) {
		throw unreadable(subject, 'column "fields" was absent from the row, so the read is incomplete');
	}

	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '') return null;
		return trimmed
			.split(',')
			.map((entry) => entry.trim())
			.sort();
	}

	return assertStringArray(subject, 'fields', value);
}

function assertStringArray(subject: string, field: string, value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw unreadable(subject, `column "${field}" holds a ${typeof value} where a string list belongs`);
	}

	for (const entry of value) {
		if (typeof entry !== 'string') {
			throw unreadable(subject, `column "${field}" contains a ${typeof entry} element where a string belongs`);
		}
	}

	return [...(value as string[])].sort();
}

/**
 * Identity and policy-bearing columns are validated because a wrong type either breaks a filename or
 * degrades an authority invariant. `admin_access` is read by truthiness in the last-administrator
 * check, so a string "false" would count as an administrator. Display-only columns are left alone.
 */
function assertRoleRow(role: Record<string, any>): void {
	const id = role['id'];

	if (typeof id !== 'string' || id === '') {
		throw unreadable('a role row', 'column "id" is not a non-empty string');
	}

	const subject = `role id=${safeLogFragment(id)}`;
	const key = role['key'];

	if (typeof key !== 'string' || key === '' || normalizeRoleKey(key) !== key) {
		throw unreadable(subject, `column "key" is not a usable role key`);
	}

	for (const field of ['admin_access', 'app_access'] as const) {
		if (typeof role[field] !== 'boolean') {
			throw unreadable(subject, `column "${field}" holds a ${typeof role[field]} where a boolean belongs`);
		}
	}

	if (role['enforce_tfa'] != null && typeof role['enforce_tfa'] !== 'boolean') {
		throw unreadable(subject, `column "enforce_tfa" holds a ${typeof role['enforce_tfa']} where a boolean belongs`);
	}

	if (role['ip_access'] != null && typeof role['ip_access'] !== 'string') {
		assertStringArray(subject, 'ip_access', role['ip_access']);
	}
}

function assertPermissionRow(perm: Record<string, any>): void {
	const id = perm['id'];
	const subject = `permission id=${safeLogFragment(id)}`;

	if (typeof perm['role'] !== 'string' || perm['role'] === '') {
		throw unreadable(subject, 'column "role" is not a non-empty string');
	}

	if (typeof perm['collection'] !== 'string' || perm['collection'] === '') {
		throw unreadable(subject, 'column "collection" is not a non-empty string');
	}

	if (typeof perm['action'] !== 'string' || !SUPPORTED_ACTIONS.has(perm['action'])) {
		throw unreadable(
			subject,
			`column "action" holds "${safeLogFragment(perm['action'])}", which is not a supported action`
		);
	}
}

export async function getConfigSnapshot(options?: { database?: Knex; schema?: SchemaOverview }): Promise<CairnConfig> {
	const database = options?.database ?? getDatabase();
	const schema = options?.schema ?? (await getSchema({ database, bypassCache: true }));

	const rolesService = new RolesService({ knex: database, schema });
	const permissionsService = new PermissionsService({ knex: database, schema });

	const rolesRaw = await rolesService.readByQuery({ limit: -1 }, UNFILTERED);

	const roleKeyById = new Map<string, string>();
	const roles: ConfigRole[] = [];

	for (const role of rolesRaw) {
		assertRoleRow(role);

		roleKeyById.set(role['id'], role['key']);

		// Sentinel is a system-managed row representing unauthenticated access;
		// its UUID→key mapping stays in roleKeyById so permissions on it group
		// under the "public" key, but the role itself has no configurable
		// surface and doesn't belong in config.roles.
		if (role['id'] === PUBLIC_ROLE_ID) continue;

		const configRole: ConfigRole = {
			key: role['key'],
			name: role['name'],
			admin_access: role['admin_access'],
			app_access: role['app_access'],
		};

		if (role['icon'] != null) configRole.icon = role['icon'];
		if (role['description'] != null) configRole.description = role['description'];
		if (role['enforce_tfa'] != null) configRole.enforce_tfa = role['enforce_tfa'];

		if (role['ip_access'] != null) {
			configRole.ip_access =
				typeof role['ip_access'] === 'string'
					? parseStoredCSV(role['id'], role['ip_access'])
					: assertStringArray(`role id=${safeLogFragment(role['id'])}`, 'ip_access', role['ip_access']);
		}

		roles.push(configRole);
	}

	const permissionsRaw = await permissionsService.readByQuery({ limit: -1 }, UNFILTERED);

	const permissionsByRoleKey = new Map<string, ConfigPermission[]>();
	const seen = new Set<string>();
	let orphanedCount = 0;

	for (const perm of permissionsRaw) {
		if (perm['system'] === true) continue;

		assertPermissionRow(perm);

		const roleId = perm['role'];
		const roleKey = roleKeyById.get(roleId);

		if (!roleKey) {
			// role column is NOT NULL post-sentinel-refactor. If a permission
			// row doesn't resolve to a known role (including the sentinel),
			// treat it as orphaned and warn the operator.
			orphanedCount++;
			logger.warn(`Permission id=${perm['id']} references non-existent role ${roleId} — skipped in snapshot.`);
			continue;
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
			permissions: parseStoredJSON('permissions', perm['id'], perm['permissions']),
			validation: parseStoredJSON('validation', perm['id'], perm['validation']),
			presets: parseStoredJSON('presets', perm['id'], perm['presets']),
			fields: parseStoredCSV(perm['id'], perm['fields']),
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
