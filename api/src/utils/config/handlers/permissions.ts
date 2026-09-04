import { PUBLIC_ROLE_KEY } from '@cairncms/constants';
import type { PermissionsAction } from '@cairncms/types';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import { PermissionsService } from '../../../services/permissions.js';
import type {
	ConfigFailure,
	ConfigPermission,
	ConfigPermissionSet,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigPlanWarning,
	PermissionFieldChanges,
	PermissionIdentity,
	PermissionValues,
} from '../../../types/config.js';
import { PERMISSION_COLLECTION_MAX_LENGTH, ROLE_KEY_MAX_LENGTH, SUPPORTED_ACTIONS } from '../../config-contract.js';
import { safeLogFragment } from '../../safe-log-fragment.js';
import type {
	ApplyContext,
	ConfigFieldDescriptor,
	ConfigReadMode,
	ConfigResourceDescriptor,
	EnrichContext,
	FieldSensitivity,
	KindPlan,
	PlanContext,
	ReadContext,
	ReadCurrentResult,
	ReadStateProjection,
	ValidationContext,
} from '../descriptor.js';
import { identityConflict, invalid } from '../failures.js';
import { comparePermissionIdentity } from '../identity-order.js';
import { UNFILTERED, parseStoredCSV, parseStoredJSON, unreadable } from '../read-parsing.js';
import { compareCodeUnits } from '../canonical-encode.js';
import { changesToValues, composeValues, sortedOrNull } from '../values.js';
import type { RolesKindTypes } from './roles.js';

const NON_SECRET: FieldSensitivity = { secret: false, redact: 'none' };

type FlatPermissionRecord = ConfigPermission & { role: string };

export interface PermissionsKindTypes {
	Kind: 'permissions';
	Document: ConfigPermissionSet;
	Record: FlatPermissionRecord;
	Values: PermissionValues;
	Identity: PermissionIdentity;
	DocumentIdentity: { role: string };
	Create: { roleKey: string; permission: ConfigPermission };
	Update: { roleKey: string; collection: string; action: PermissionsAction; changes: PermissionFieldChanges };
	Delete: { roleKey: string; collection: string; action: PermissionsAction };
	Changes: PermissionFieldChanges;
	ReadDependencyState: undefined;
	ApplyDependencyState: undefined;
	ReadDependencies: { roles: RolesKindTypes['ReadDependencyState'] };
	PlanDependencies: { roles: KindPlan<RolesKindTypes> };
	ApplyDependencies: { roles: RolesKindTypes['ApplyDependencyState'] };
	Enrichment: { warnings: ConfigPlanWarning[] };
	ResultSlice: { created: number; updated: number; deleted: number };
	Outcome: { op: 'create'; count: number } | { op: 'update'; count: number } | { op: 'delete'; count: number };
}

const ROLE_FIELD: ConfigFieldDescriptor = {
	name: 'role',
	type: 'string',
	required: true,
	nullable: false,
	minLength: 1,
	maxLength: ROLE_KEY_MAX_LENGTH,
	grammar: 'role-key',
	acceptsPlaceholder: false,
	sensitivity: NON_SECRET,
	snapshotSafe: true,
	mutable: false,
	omissionPreservesCurrent: false,
};

const POLICY_FIELD = (name: string): ConfigFieldDescriptor => ({
	name,
	type: 'policy-object',
	required: true,
	nullable: true,
	acceptsPlaceholder: false,
	sensitivity: NON_SECRET,
	snapshotSafe: true,
	mutable: true,
	omissionPreservesCurrent: false,
});

const RECORD_FIELDS: ConfigFieldDescriptor[] = [
	{
		name: 'collection',
		type: 'string',
		required: true,
		nullable: false,
		minLength: 1,
		maxLength: PERMISSION_COLLECTION_MAX_LENGTH,
		acceptsPlaceholder: false,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: false,
		omissionPreservesCurrent: false,
		identityComponent: true,
	},
	{
		name: 'action',
		type: 'string',
		required: true,
		nullable: false,
		enum: [...SUPPORTED_ACTIONS],
		acceptsPlaceholder: false,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: false,
		omissionPreservesCurrent: false,
		identityComponent: true,
	},
	POLICY_FIELD('permissions'),
	POLICY_FIELD('validation'),
	POLICY_FIELD('presets'),
	{
		name: 'fields',
		type: 'string-list',
		required: true,
		nullable: true,
		allowEmptyElements: true,
		acceptsPlaceholder: false,
		canonicalize: (value) => sortedOrNull(value),
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: false,
	},
];

const VALUE_FIELD_ORDER = ['permissions', 'validation', 'presets', 'fields'] as const;

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

async function readCurrent(context: ReadContext<PermissionsKindTypes>): Promise<{
	records: FlatPermissionRecord[];
	documentIdentities: { role: string }[];
	dependencyState: undefined;
}> {
	const { roleKeyById } = context.dependency('roles');
	const permissionsService = new PermissionsService({ knex: context.database, schema: context.schema });
	const rows = await permissionsService.readByQuery({ limit: -1 }, UNFILTERED);

	const permissionsByRoleKey = new Map<string, ConfigPermission[]>();
	const seen = new Set<string>();

	for (const perm of rows) {
		if (perm['system'] === true) continue;

		assertPermissionRow(perm);

		const roleKey = roleKeyById.get(perm['role']);

		if (!roleKey) {
			throw unreadable(
				'the permissions table',
				'one or more permission rows reference a role that does not exist, so the database needs repair before the current state can be read'
			);
		}

		const tupleKey = `${roleKey}::${perm['collection']}::${perm['action']}`;

		if (seen.has(tupleKey)) {
			throw unreadable(
				`permissions for role key=${safeLogFragment(roleKey)}`,
				`collection "${safeLogFragment(perm['collection'])}" with action "${safeLogFragment(
					perm['action']
				)}" is stored more than once, so the rows must be deduplicated before the current state can be read`
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

	const roleKeys = [...permissionsByRoleKey.keys()].sort((a, b) => a.localeCompare(b));
	const records: FlatPermissionRecord[] = [];

	for (const roleKey of roleKeys) {
		const perms = permissionsByRoleKey.get(roleKey)!;

		perms.sort((a, b) => {
			const byCollection = a.collection.localeCompare(b.collection);
			if (byCollection !== 0) return byCollection;
			return a.action.localeCompare(b.action);
		});

		for (const perm of perms) records.push({ role: roleKey, ...perm });
	}

	return {
		records,
		documentIdentities: roleKeys.map((role) => ({ role })),
		dependencyState: undefined,
	};
}

function permissionIdentity(record: FlatPermissionRecord): string {
	return JSON.stringify([record.role, record.collection, record.action]);
}

function projectReadState(result: ReadCurrentResult<PermissionsKindTypes>, mode: ConfigReadMode): ReadStateProjection {
	if (mode === 'identity') {
		return { mode, identities: result.records.map(permissionIdentity).sort(compareCodeUnits) };
	}

	const values = result.records
		.map((record): [string, unknown] => [
			permissionIdentity(record),
			composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>),
		])
		.sort((a, b) => compareCodeUnits(a[0], b[0]));

	return { mode, identities: values.map(([key]) => key), values };
}

function validateDesired(
	documents: ConfigPermissionSet[],
	_records: FlatPermissionRecord[],
	context: ValidationContext
): ConfigFailure[] {
	const failures: ConfigFailure[] = [];
	const subjects = new Set<string>();

	for (const set of documents) {
		const subject = safeLogFragment(set.role);

		if (subjects.has(set.role)) {
			failures.push(identityConflict(`Duplicate permission set for role "${subject}".`));
		}

		subjects.add(set.role);

		if (set.role !== PUBLIC_ROLE_KEY) {
			if (context.rolesManaged) {
				if (!context.declaredRoleKeys.has(set.role)) {
					failures.push(invalid(`Permission set references role "${subject}", which no role file declares.`));
				}
			} else {
				switch (context.references) {
					case 'current-state':
						if (!context.currentRoleKeys.has(set.role)) {
							failures.push(
								invalid(`Permission set references role "${subject}", which does not exist in the database.`)
							);
						}

						break;
					case 'server-snapshot':
						break;

					default: {
						const unsupported: never = context;
						throw new Error(`Unsupported role reference source: ${JSON.stringify(unsupported)}`);
					}
				}
			}
		}

		const tuples = new Set<string>();

		for (const permission of set.permissions) {
			const tuple = `${permission.collection}:${permission.action}`;

			if (tuples.has(tuple)) {
				failures.push(
					identityConflict(
						`Duplicate permission for role "${subject}": collection "${safeLogFragment(
							permission.collection
						)}", action "${safeLogFragment(permission.action)}".`
					)
				);
			}

			tuples.add(tuple);
		}
	}

	return failures;
}

function postPlan(
	plan: KindPlan<PermissionsKindTypes>,
	context: PlanContext<PermissionsKindTypes>
): KindPlan<PermissionsKindTypes> {
	const deletedRoleKeys = new Set(context.dependency('roles').delete);

	return {
		create: plan.create,
		update: plan.update,
		delete: plan.delete.filter((entry) => !deletedRoleKeys.has(entry.roleKey)),
	};
}

async function enrich(
	_plan: KindPlan<PermissionsKindTypes>,
	records: FlatPermissionRecord[],
	context: EnrichContext
): Promise<PermissionsKindTypes['Enrichment']> {
	const warnings: ConfigPlanWarning[] = [];

	for (const record of records) {
		if (Object.hasOwn(context.schema.collections, record.collection)) continue;

		warnings.push({
			code: 'COLLECTION_MISSING',
			kind: 'permissions',
			identity: { role: record.role, collection: record.collection, action: record.action },
			message: `Permission for role "${record.role}" targets collection "${record.collection}", which does not exist in the schema.`,
		});
	}

	warnings.sort((a, b) => comparePermissionIdentity(a.identity, b.identity));

	return { warnings };
}

function emptyEnrichment(): PermissionsKindTypes['Enrichment'] {
	return { warnings: [] };
}

function toChanges(plan: KindPlan<PermissionsKindTypes>, _enrichment: ConfigPlanEnrichment): ConfigPlanChange[] {
	const changes: ConfigPlanChange[] = [];

	for (const create of plan.create) {
		changes.push({
			kind: 'permissions',
			operation: 'create',
			identity: { role: create.roleKey, collection: create.permission.collection, action: create.permission.action },
			values: composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, {
				role: create.roleKey,
				...create.permission,
			} as unknown as Record<string, unknown>) as PermissionValues,
		});
	}

	for (const update of plan.update) {
		changes.push({
			kind: 'permissions',
			operation: 'update',
			identity: { role: update.roleKey, collection: update.collection, action: update.action },
			fields: update.changes,
		});
	}

	for (const del of plan.delete) {
		changes.push({
			kind: 'permissions',
			operation: 'delete',
			identity: { role: del.roleKey, collection: del.collection, action: del.action },
			impact: [],
		});
	}

	return changes;
}

function permissionsServiceFor(context: ApplyContext<PermissionsKindTypes>): PermissionsService {
	return new PermissionsService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});
}

async function applyCreates(
	creates: PermissionsKindTypes['Create'][],
	context: ApplyContext<PermissionsKindTypes>
): Promise<Extract<PermissionsKindTypes['Outcome'], { op: 'create' }>> {
	if (creates.length === 0) return { op: 'create', count: 0 };

	const { roleIdByKey } = context.dependency('roles');
	const permissionsService = permissionsServiceFor(context);
	let count = 0;

	for (const { roleKey, permission } of creates) {
		const roleId = roleIdByKey.get(roleKey);
		if (roleId === undefined) throw new Error(`Cannot create permission: role "${roleKey}" not found.`);

		await permissionsService.createOne(
			{
				role: roleId,
				collection: permission.collection,
				action: permission.action,
				...(composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, {
					role: roleKey,
					...permission,
				} as unknown as Record<string, unknown>) as PermissionValues),
			},
			context.mutationOptions
		);

		count++;
	}

	return { op: 'create', count };
}

async function applyUpdates(
	updates: PermissionsKindTypes['Update'][],
	context: ApplyContext<PermissionsKindTypes>
): Promise<Extract<PermissionsKindTypes['Outcome'], { op: 'update' }>> {
	if (updates.length === 0) return { op: 'update', count: 0 };

	const { roleIdByKey } = context.dependency('roles');
	const permissionsService = permissionsServiceFor(context);
	let count = 0;

	for (const { roleKey, collection, action, changes } of updates) {
		const roleId = roleIdByKey.get(roleKey);
		if (roleId === undefined) throw new Error(`Cannot update permission: role "${roleKey}" not found.`);

		const existing = await context
			.database('directus_permissions')
			.select('id')
			.where({ collection, action, role: roleId })
			.first();

		if (existing === undefined) {
			throw new Error(
				`Permission not found for update: role="${roleKey}" collection="${collection}" action="${action}".`
			);
		}

		await permissionsService.updateOne(
			existing['id'],
			changesToValues(changes) as Partial<PermissionValues>,
			context.mutationOptions
		);

		count++;
	}

	return { op: 'update', count };
}

async function applyDeletes(
	deletes: PermissionsKindTypes['Delete'][],
	context: ApplyContext<PermissionsKindTypes>
): Promise<Extract<PermissionsKindTypes['Outcome'], { op: 'delete' }>> {
	if (deletes.length === 0) return { op: 'delete', count: 0 };

	const { roleIdByKey } = context.dependency('roles');
	const permissionsService = permissionsServiceFor(context);
	let count = 0;

	for (const { roleKey, collection, action } of deletes) {
		const roleId = roleIdByKey.get(roleKey);
		if (roleId === undefined) continue;

		const existing = await context
			.database('directus_permissions')
			.select('id')
			.where({ collection, action, role: roleId })
			.first();

		if (existing !== undefined) {
			await permissionsService.deleteOne(existing['id'], context.mutationOptions);
			count++;
		}
	}

	return { op: 'delete', count };
}

async function readApplyDependencyState(): Promise<PermissionsKindTypes['ApplyDependencyState']> {
	return undefined;
}

function emptyResult(): PermissionsKindTypes['ResultSlice'] {
	return { created: 0, updated: 0, deleted: 0 };
}

function mergeOutcome(
	slice: PermissionsKindTypes['ResultSlice'],
	outcome: PermissionsKindTypes['Outcome']
): PermissionsKindTypes['ResultSlice'] {
	switch (outcome.op) {
		case 'create':
			return { ...slice, created: slice.created + outcome.count };
		case 'update':
			return { ...slice, updated: slice.updated + outcome.count };
		case 'delete':
			return { ...slice, deleted: slice.deleted + outcome.count };
	}
}

export const permissionsDescriptor: ConfigResourceDescriptor<PermissionsKindTypes> = {
	kind: 'permissions',
	formatVersion: 1,
	dependencies: ['roles'],
	layout: {
		directory: 'permissions',
		documentShape: { recordsField: 'permissions' },
		documentIdentityOf: (document) => ({ role: document.role }),
		filenameOf: (documentIdentity) => documentIdentity.role,
		parseDocumentFile: (record, filename) => {
			if (!record['role']) {
				throw new ConfigInvalidException(`Invalid permission file: ${filename} — missing "role" field.`);
			}

			if (!Array.isArray(record['permissions'])) {
				throw new ConfigInvalidException(`Invalid permission file: ${filename} — "permissions" must be an array.`);
			}

			const expected = `${record['role']}.yaml`;

			if (filename !== expected) {
				throw new ConfigInvalidException(
					`Permission file "${filename}" contains role "${safeLogFragment(
						record['role']
					)}" — filename must match role ("${safeLogFragment(expected)}").`
				);
			}

			return record as unknown as ConfigPermissionSet;
		},
	},
	documentIdentityFields: [ROLE_FIELD],
	recordFields: RECORD_FIELDS,
	valueFieldOrder: VALUE_FIELD_ORDER,
	emittedDocumentSubject: (identity) => ({ label: 'permissions for role key', value: identity.role }),
	projectDocuments: (documents) => ({
		records: documents.flatMap((set) => set.permissions.map((permission) => ({ role: set.role, ...permission }))),
		anchors: documents.map((set) => ({ role: set.role })),
	}),
	composeDocuments: (records, anchors) => {
		const byRole = new Map<string, ConfigPermission[]>();

		for (const record of records) {
			const { role, ...permission } = record;
			if (!byRole.has(role)) byRole.set(role, []);
			byRole.get(role)!.push(permission);
		}

		return anchors.map((anchor) => ({ role: anchor.role, permissions: byRole.get(anchor.role) ?? [] }));
	},
	identityOf: (record) => ({ role: record.role, collection: record.collection, action: record.action }),
	identityKey: (identity) => JSON.stringify([identity.role, identity.collection, identity.action]),
	compareIdentity: comparePermissionIdentity,
	identityOfDelete: (entry) => ({ role: entry.roleKey, collection: entry.collection, action: entry.action }),
	canonicalizeValues: (record) =>
		composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>) as PermissionValues,
	toCreateEntry: (record) => {
		const { role, ...permission } = record;
		return { roleKey: role, permission };
	},
	toUpdateEntry: (identity, changes) => ({
		roleKey: identity.role,
		collection: identity.collection,
		action: identity.action,
		changes,
	}),
	toDeleteEntry: (identity) => ({ roleKey: identity.role, collection: identity.collection, action: identity.action }),
	handler: {
		readCurrent,
		projectReadState,
		validateDesired,
		postPlan,
		enrich,
		emptyEnrichment,
		toChanges,
		applyCreates,
		applyUpdates,
		applyDeletes,
		readApplyDependencyState,
		emptyResult,
		mergeOutcome,
	},
};
