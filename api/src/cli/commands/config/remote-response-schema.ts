import { isPlainObject } from 'lodash-es';
import { z } from 'zod';
import { SUPPORTED_ACTIONS } from '../../../utils/config-contract.js';

const count = z.number().int().nonnegative();
const nullableRecord = z.record(z.unknown()).nullable();
const nullableStringArray = z.array(z.string()).nullable();
const action = z.string().refine((value) => SUPPORTED_ACTIONS.has(value));

const roleIdentity = z.object({ key: z.string() }).passthrough();
const folderIdentity = z.object({ key: z.string() }).passthrough();
const settingsIdentity = z.object({ key: z.string() }).passthrough();
const permissionIdentity = z.object({ role: z.string(), collection: z.string(), action }).passthrough();

const extensionSettingsIdentity = z
	.object({ subject: z.string(), scope: z.enum(['global', 'collection']), scope_key: z.string(), key: z.string() })
	.passthrough();

const translationsIdentity = z.object({ language: z.string(), key: z.string() }).passthrough();

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

const folderValues = z.object({ name: z.string(), parent: z.string().nullable() }).passthrough();

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

const folderBlocker = z
	.object({ blockedBy: z.enum(['files', 'folders', 'storage_default_folder', 'options.folder']) })
	.passthrough();

const folderImpact = z.array(folderBlocker);

export const RemoteConfigPlanChange = z.union([
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
	z
		.object({
			kind: z.literal('folders'),
			operation: z.literal('create'),
			identity: folderIdentity,
			values: folderValues,
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('folders'),
			operation: z.literal('update'),
			identity: folderIdentity,
			fields: fieldChanges,
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('folders'),
			operation: z.literal('delete'),
			identity: folderIdentity,
			impact: folderImpact,
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('settings'),
			operation: z.literal('update'),
			identity: settingsIdentity,
			fields: fieldChanges,
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('extension-settings'),
			operation: z.literal('create'),
			identity: extensionSettingsIdentity,
			values: z.object({ value: z.unknown() }).passthrough(),
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('extension-settings'),
			operation: z.literal('update'),
			identity: extensionSettingsIdentity,
			fields: fieldChanges,
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('extension-settings'),
			operation: z.literal('delete'),
			identity: extensionSettingsIdentity,
			impact: emptyImpact,
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('translations'),
			operation: z.literal('create'),
			identity: translationsIdentity,
			values: z.object({ value: z.string() }).passthrough(),
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('translations'),
			operation: z.literal('update'),
			identity: translationsIdentity,
			fields: fieldChanges,
		})
		.passthrough(),
	z
		.object({
			kind: z.literal('translations'),
			operation: z.literal('delete'),
			identity: translationsIdentity,
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
		changes: z.array(RemoteConfigPlanChange),
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
		folders: z
			.object({ created: z.array(z.string()), updated: z.array(z.string()), deleted: z.array(z.string()) })
			.passthrough(),
		settings: z.object({ updated: z.array(z.string()) }).passthrough(),
		'extension-settings': z.object({ created: count, updated: count, deleted: count }).passthrough(),
		translations: z.object({ created: count, updated: count, deleted: count }).passthrough(),
	})
	.passthrough();

const deletion = z.union([
	z.object({ kind: z.literal('roles'), identity: roleIdentity }).passthrough(),
	z.object({ kind: z.literal('permissions'), identity: permissionIdentity }).passthrough(),
	z.object({ kind: z.literal('folders'), identity: folderIdentity }).passthrough(),
	z.object({ kind: z.literal('extension-settings'), identity: extensionSettingsIdentity }).passthrough(),
	z.object({ kind: z.literal('translations'), identity: translationsIdentity }).passthrough(),
]);

export const RemoteErrorEnvelope = z.object({ errors: z.array(z.unknown()) }).passthrough();

export const RemoteErrorEntry = z.object({ message: z.string().min(1) }).passthrough();

export const RemoteErrorExtensions = z.union([
	z.object({ code: z.literal('DESTRUCTIVE_CHANGES_REQUIRED'), deletions: z.array(deletion) }).passthrough(),
	z.object({ code: z.literal('CONFIG_PROTECTED_RECORD'), contributors: z.array(contributor) }).passthrough(),
]);

export type RemoteWirePlan = z.infer<typeof RemoteConfigPlan>;

export type RemoteWireResult = z.infer<typeof RemoteApplyResult>;
