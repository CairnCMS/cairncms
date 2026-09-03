import { isPlainObject } from 'lodash-es';
import { z } from 'zod';
import { SUPPORTED_ACTIONS } from '../../../utils/config-contract.js';

const count = z.number().int().nonnegative();
const nullableRecord = z.record(z.unknown()).nullable();
const nullableStringArray = z.array(z.string()).nullable();
const action = z.string().refine((value) => SUPPORTED_ACTIONS.has(value));

const roleIdentity = z.object({ key: z.string() }).passthrough();
const permissionIdentity = z.object({ role: z.string(), collection: z.string(), action }).passthrough();

const fieldChange = z.custom<{ before: unknown; after: unknown }>(
	(value) => isPlainObject(value) && 'before' in (value as object) && 'after' in (value as object)
);

const fieldChanges = z.record(fieldChange);

const roleValues = z
	.object({
		name: z.string(),
		icon: z.string(),
		description: z.string().nullable(),
		admin_access: z.boolean(),
		app_access: z.boolean(),
		enforce_tfa: z.boolean(),
		ip_access: nullableStringArray,
	})
	.passthrough();

const permissionValues = z
	.object({
		permissions: nullableRecord,
		validation: nullableRecord,
		presets: nullableRecord,
		fields: nullableStringArray,
	})
	.passthrough();

const permissionsImpact = z.object({ kind: z.literal('permissions'), identity: permissionIdentity }).passthrough();
const presetsImpact = z.object({ kind: z.literal('presets'), count, bookmarks: z.array(z.string()) }).passthrough();
const usersImpact = z.object({ kind: z.literal('users'), suspended: z.array(z.string()) }).passthrough();
const sessionsImpact = z.object({ kind: z.literal('sessions'), active: count }).passthrough();

const KNOWN_IMPACT_KINDS = new Set(['permissions', 'presets', 'users', 'sessions']);

const impact = z.array(
	z.union([
		z.discriminatedUnion('kind', [permissionsImpact, presetsImpact, usersImpact, sessionsImpact]),
		z
			.object({ kind: z.string() })
			.passthrough()
			.refine((entry) => !KNOWN_IMPACT_KINDS.has(entry.kind)),
	])
);

const emptyImpact = z.array(z.unknown()).max(0);

const change = z.union([
	z
		.object({ kind: z.literal('roles'), operation: z.literal('create'), identity: roleIdentity, values: roleValues })
		.passthrough(),
	z
		.object({ kind: z.literal('roles'), operation: z.literal('update'), identity: roleIdentity, fields: fieldChanges })
		.passthrough(),
	z.object({ kind: z.literal('roles'), operation: z.literal('delete'), identity: roleIdentity, impact }).passthrough(),
	z
		.object({
			kind: z.literal('permissions'),
			operation: z.literal('create'),
			identity: permissionIdentity,
			values: permissionValues,
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('permissions'),
			operation: z.literal('update'),
			identity: permissionIdentity,
			fields: fieldChanges,
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('permissions'),
			operation: z.literal('delete'),
			identity: permissionIdentity,
			impact: emptyImpact,
		})
		.passthrough(),
]);

const contributor = z
	.object({ kind: z.literal('roles'), operation: z.enum(['update', 'delete']), identity: roleIdentity })
	.passthrough();

const protection = z
	.object({ code: z.string(), message: z.string(), contributors: z.array(contributor) })
	.passthrough();

const warning = z.union([
	z
		.object({
			code: z.literal('COLLECTION_MISSING'),
			kind: z.literal('permissions'),
			identity: permissionIdentity,
			message: z.string(),
		})
		.passthrough(),
	z
		.object({ code: z.string(), message: z.string() })
		.passthrough()
		.refine((entry) => entry.code !== 'COLLECTION_MISSING'),
]);

export const RemoteConfigPlan = z
	.object({
		planVersion: z.literal(2),
		manifestVersion: z.number(),
		summary: z.object({ create: count, update: count, delete: count }).passthrough(),
		changes: z.array(change),
		protections: z.array(protection),
		warnings: z.array(warning),
	})
	.passthrough();

export const RemoteApplyResult = z
	.object({
		roles: z
			.object({ created: z.array(z.string()), updated: z.array(z.string()), deleted: z.array(z.string()) })
			.passthrough(),
		permissions: z.object({ created: count, updated: count, deleted: count }).passthrough(),
	})
	.passthrough();

export type RemoteWirePlan = z.infer<typeof RemoteConfigPlan>;

export type RemoteWireResult = z.infer<typeof RemoteApplyResult>;
