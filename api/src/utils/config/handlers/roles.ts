import { PUBLIC_ROLE_ID, PUBLIC_ROLE_KEY } from '@cairncms/constants';
import { normalizeRoleKey } from '@cairncms/utils';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import { RolesService } from '../../../services/roles.js';
import type {
	ApplyResult,
	ConfigFailure,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigRole,
	RoleDeletionImpactEntry,
	RoleFieldChanges,
	RoleIdentity,
	RoleValues,
} from '../../../types/config.js';
import { ROLE_ICON_MAX_LENGTH, ROLE_KEY_MAX_LENGTH, ROLE_NAME_MAX_LENGTH } from '../../config-contract.js';
import { safeLogFragment } from '../../safe-log-fragment.js';
import type {
	ApplyContext,
	ConfigFieldDescriptor,
	ConfigReadMode,
	ConfigResourceDescriptor,
	EnrichContext,
	FieldSensitivity,
	KindPlan,
	NoConfigDependencies,
	ReadContext,
	ReadCurrentResult,
	ReadStateProjection,
} from '../descriptor.js';
import { identityConflict } from '../failures.js';
import { interpolateEnvVar } from '../placeholder.js';
import { UNFILTERED, assertStringArray, parseStoredCSV, unreadable } from '../read-parsing.js';
import { compareCodeUnits } from '../canonical-encode.js';
import { changesToValues, composeValues, sortedOrNull } from '../values.js';
import { normalizeImpact, readRoleDeletionImpact } from './roles-impact.js';

const DEFAULT_ROLE_ICON = 'supervised_user_circle';

const NON_SECRET: FieldSensitivity = { secret: false, redact: 'none' };

export interface RolesKindTypes {
	Kind: 'roles';
	Document: ConfigRole;
	Record: ConfigRole;
	Values: RoleValues;
	Identity: RoleIdentity;
	DocumentIdentity: RoleIdentity;
	Create: ConfigRole;
	Update: { key: string; changes: RoleFieldChanges };
	Delete: string;
	Changes: RoleFieldChanges;
	ReadDependencyState: { currentRoleKeys: ReadonlySet<string>; roleKeyById: Map<string, string> };
	ApplyDependencyState: { roleIdByKey: Map<string, string> };
	ReadDependencies: NoConfigDependencies;
	PlanDependencies: NoConfigDependencies;
	ApplyDependencies: NoConfigDependencies;
	Enrichment: { roleDeletionImpact: Map<string, RoleDeletionImpactEntry[]> };
	ResultSlice: ApplyResult['roles'];
	Outcome:
		| { op: 'create'; created: string[] }
		| { op: 'update'; updated: string[] }
		| { op: 'delete'; deleted: string[] };
}

const KEY_FIELD: ConfigFieldDescriptor = {
	name: 'key',
	type: 'string',
	required: true,
	nullable: false,
	minLength: 1,
	maxLength: ROLE_KEY_MAX_LENGTH,
	grammar: 'role-key',
	reserved: [PUBLIC_ROLE_KEY],
	acceptsPlaceholder: false,
	sensitivity: NON_SECRET,
	snapshotSafe: true,
	mutable: false,
	omissionPreservesCurrent: false,
};

const RECORD_FIELDS: ConfigFieldDescriptor[] = [
	{
		name: 'name',
		type: 'string',
		required: true,
		nullable: false,
		allowEmpty: true,
		maxLength: ROLE_NAME_MAX_LENGTH,
		acceptsPlaceholder: true,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: false,
	},
	{
		name: 'admin_access',
		type: 'boolean',
		required: true,
		nullable: false,
		acceptsPlaceholder: false,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: false,
	},
	{
		name: 'app_access',
		type: 'boolean',
		required: true,
		nullable: false,
		acceptsPlaceholder: false,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: false,
	},
	{
		name: 'icon',
		type: 'string',
		required: false,
		nullable: false,
		allowEmpty: true,
		maxLength: ROLE_ICON_MAX_LENGTH,
		acceptsPlaceholder: false,
		canonicalize: (value) => value ?? DEFAULT_ROLE_ICON,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: true,
	},
	{
		name: 'enforce_tfa',
		type: 'boolean',
		required: false,
		nullable: false,
		acceptsPlaceholder: false,
		canonicalize: (value) => value ?? false,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: true,
	},
	{
		name: 'description',
		type: 'string',
		required: false,
		nullable: true,
		allowEmpty: true,
		acceptsPlaceholder: true,
		canonicalize: (value) => value ?? null,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: true,
	},
	{
		name: 'ip_access',
		type: 'string-list',
		required: false,
		nullable: true,
		allowEmptyElements: true,
		acceptsPlaceholder: false,
		canonicalize: (value) => sortedOrNull(value),
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: true,
	},
];

const VALUE_FIELD_ORDER = [
	'name',
	'icon',
	'description',
	'admin_access',
	'app_access',
	'enforce_tfa',
	'ip_access',
] as const;

function assertRoleIdentity(role: Record<string, any>): void {
	const id = role['id'];

	if (typeof id !== 'string' || id === '') {
		throw unreadable('a role row', 'column "id" is not a non-empty string');
	}

	const key = role['key'];

	if (typeof key !== 'string' || key === '' || normalizeRoleKey(key) !== key) {
		throw unreadable(`role id=${safeLogFragment(id)}`, `column "key" is not a usable role key`);
	}
}

function requireColumn(role: Record<string, any>, field: string): any {
	if (role[field] === undefined) {
		throw unreadable(
			`role id=${safeLogFragment(role['id'])}`,
			`column "${field}" was absent from the row, so the read is incomplete`
		);
	}

	return role[field];
}

function readIpAccess(role: Record<string, any>): string[] | null {
	const value = requireColumn(role, 'ip_access');
	if (value === null) return null;

	if (typeof value === 'string') return parseStoredCSV(role['id'], value);
	return assertStringArray(`role id=${safeLogFragment(role['id'])}`, 'ip_access', value);
}

function assertRolePolicy(role: Record<string, any>): void {
	const subject = `role id=${safeLogFragment(role['id'])}`;

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

async function readCurrent(context: ReadContext<RolesKindTypes>): Promise<{
	records: ConfigRole[];
	documentIdentities: RoleIdentity[];
	dependencyState: RolesKindTypes['ReadDependencyState'];
}> {
	const rolesService = new RolesService({ knex: context.database, schema: context.schema });
	const full = context.readMode === 'full';
	const query = full ? { limit: -1 } : { limit: -1, fields: ['id', 'key'] };
	const rows = await rolesService.readByQuery(query, UNFILTERED);

	const roleKeyById = new Map<string, string>();
	const currentRoleKeys = new Set<string>();
	const records: ConfigRole[] = [];

	for (const role of rows) {
		assertRoleIdentity(role);
		if (full) assertRolePolicy(role);

		roleKeyById.set(role['id'], role['key']);
		currentRoleKeys.add(role['key']);

		// The sentinel keeps its id->key mapping so its permissions group under "public", but it has no
		// configurable surface of its own and never appears in config.roles.
		if (role['id'] === PUBLIC_ROLE_ID) continue;
		if (!full) continue;

		records.push({
			key: role['key'],
			name: requireColumn(role, 'name'),
			admin_access: role['admin_access'],
			app_access: role['app_access'],
			icon: requireColumn(role, 'icon'),
			enforce_tfa: requireColumn(role, 'enforce_tfa'),
			description: requireColumn(role, 'description'),
			ip_access: readIpAccess(role),
		});
	}

	records.sort((a, b) => a.key.localeCompare(b.key));

	return {
		records,
		documentIdentities: records.map((record) => ({ key: record.key })),
		dependencyState: { currentRoleKeys, roleKeyById },
	};
}

function projectReadState(result: ReadCurrentResult<RolesKindTypes>, mode: ConfigReadMode): ReadStateProjection {
	if (mode === 'identity') {
		return { mode, identities: [...result.dependencyState.currentRoleKeys].sort(compareCodeUnits) };
	}

	const values = result.records
		.map((record): [string, unknown] => [
			record.key,
			composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>),
		])
		.sort((a, b) => compareCodeUnits(a[0], b[0]));

	return { mode, identities: values.map(([key]) => key), values };
}

function validateDesired(documents: ConfigRole[]): ConfigFailure[] {
	const failures: ConfigFailure[] = [];
	const seen = new Set<string>();

	for (const document of documents) {
		if (seen.has(document.key)) {
			failures.push(identityConflict(`Duplicate role "${safeLogFragment(document.key)}".`));
		}

		seen.add(document.key);
	}

	return failures;
}

async function enrich(
	plan: KindPlan<RolesKindTypes>,
	_records: ConfigRole[],
	context: EnrichContext
): Promise<RolesKindTypes['Enrichment']> {
	return { roleDeletionImpact: await readRoleDeletionImpact(plan.delete, context.database) };
}

function emptyEnrichment(): RolesKindTypes['Enrichment'] {
	return { roleDeletionImpact: new Map() };
}

function toChanges(plan: KindPlan<RolesKindTypes>, enrichment: ConfigPlanEnrichment): ConfigPlanChange[] {
	const changes: ConfigPlanChange[] = [];

	for (const role of plan.create) {
		changes.push({
			kind: 'roles',
			operation: 'create',
			identity: { key: role.key },
			values: composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, role as unknown as Record<string, unknown>) as RoleValues,
		});
	}

	for (const update of plan.update) {
		changes.push({ kind: 'roles', operation: 'update', identity: { key: update.key }, fields: update.changes });
	}

	for (const key of plan.delete) {
		changes.push({
			kind: 'roles',
			operation: 'delete',
			identity: { key },
			impact: normalizeImpact(key, enrichment.roleDeletionImpact.get(key)),
		});
	}

	return changes;
}

async function applyCreates(
	creates: ConfigRole[],
	context: ApplyContext<RolesKindTypes>
): Promise<Extract<RolesKindTypes['Outcome'], { op: 'create' }>> {
	const created: string[] = [];
	if (creates.length === 0) return { op: 'create', created };

	const rolesService = new RolesService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});

	for (const role of creates) {
		await rolesService.createOne(
			{
				key: role.key,
				...(composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, role as unknown as Record<string, unknown>) as RoleValues),
			},
			context.mutationOptions
		);

		created.push(role.key);
	}

	return { op: 'create', created };
}

function grantsAdministrator(update: RolesKindTypes['Update']): boolean {
	const change = update.changes.admin_access;
	return change !== undefined && change.before === false && change.after === true;
}

function administratorGrantsFirst(updates: RolesKindTypes['Update'][]): RolesKindTypes['Update'][] {
	return [...updates.filter(grantsAdministrator), ...updates.filter((update) => !grantsAdministrator(update))];
}

async function applyUpdates(
	updates: RolesKindTypes['Update'][],
	context: ApplyContext<RolesKindTypes>
): Promise<Extract<RolesKindTypes['Outcome'], { op: 'update' }>> {
	const updated: string[] = [];
	if (updates.length === 0) return { op: 'update', updated };

	const rolesService = new RolesService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});

	for (const { key, changes } of updates) {
		const existing = await context.database('directus_roles').select('id').where({ key }).first();
		if (!existing) throw new Error(`Role "${key}" not found during apply.`);

		await rolesService.updateOne(
			existing['id'],
			changesToValues(changes) as Partial<RoleValues>,
			context.mutationOptions
		);

		updated.push(key);
	}

	return { op: 'update', updated };
}

async function applyDeletes(
	deletes: string[],
	context: ApplyContext<RolesKindTypes>
): Promise<Extract<RolesKindTypes['Outcome'], { op: 'delete' }>> {
	const deleted: string[] = [];
	if (deletes.length === 0) return { op: 'delete', deleted };

	const rolesService = new RolesService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});

	for (const key of deletes) {
		const existing = await context.database('directus_roles').select('id').where({ key }).first();

		if (existing) {
			await rolesService.deleteOne(existing['id'], context.mutationOptions);
			deleted.push(key);
		}
	}

	return { op: 'delete', deleted };
}

async function readApplyDependencyState(
	context: ApplyContext<RolesKindTypes>
): Promise<RolesKindTypes['ApplyDependencyState']> {
	const rows = await context.database('directus_roles').select('id', 'key');
	const roleIdByKey = new Map<string, string>();
	for (const row of rows) roleIdByKey.set(row['key'], row['id']);
	return { roleIdByKey };
}

function emptyResult(): RolesKindTypes['ResultSlice'] {
	return { created: [], updated: [], deleted: [] };
}

function mergeOutcome(
	slice: RolesKindTypes['ResultSlice'],
	outcome: RolesKindTypes['Outcome']
): RolesKindTypes['ResultSlice'] {
	switch (outcome.op) {
		case 'create':
			return { ...slice, created: [...slice.created, ...outcome.created] };
		case 'update':
			return { ...slice, updated: [...slice.updated, ...outcome.updated] };
		case 'delete':
			return { ...slice, deleted: [...slice.deleted, ...outcome.deleted] };
	}
}

export const rolesDescriptor: ConfigResourceDescriptor<RolesKindTypes> = {
	kind: 'roles',
	formatVersion: 1,
	dependencies: [],
	layout: {
		directory: 'roles',
		documentShape: 'flat',
		documentIdentityOf: (document) => ({ key: document.key }),
		filenameOf: (documentIdentity) => documentIdentity.key,
		parseDocumentFile: (record, filename) => {
			if (!record['key']) {
				throw new ConfigInvalidException(`Invalid role file: ${filename} — missing "key" field.`);
			}

			const expected = `${record['key']}.yaml`;

			if (filename !== expected) {
				throw new ConfigInvalidException(
					`Role file "${filename}" contains key "${safeLogFragment(
						record['key']
					)}" — filename must match key ("${safeLogFragment(expected)}").`
				);
			}

			const document: Record<string, unknown> = { ...record };
			const subject = { label: 'role', value: record['key'] };

			for (const field of RECORD_FIELDS) {
				const value = document[field.name];

				if (field.acceptsPlaceholder && typeof value === 'string') {
					document[field.name] = interpolateEnvVar(value, field.name, subject);
				}
			}

			return document as unknown as ConfigRole;
		},
		reservedFilenameMessage: () =>
			`Role key "public" is reserved for public permissions. Remove roles/public.yaml. ` +
			`Public permissions belong in permissions/public.yaml only.`,
	},
	documentIdentityFields: [KEY_FIELD],
	recordFields: RECORD_FIELDS,
	valueFieldOrder: VALUE_FIELD_ORDER,
	emittedDocumentSubject: (identity) => ({ label: 'role key', value: identity.key }),
	projectDocuments: (documents) => ({
		records: documents,
		anchors: documents.map((document) => ({ key: document.key })),
	}),
	composeDocuments: (records) => records,
	identityOf: (record) => ({ key: record.key }),
	identityKey: (identity) => JSON.stringify([identity.key]),
	compareIdentity: (a, b) => a.key.localeCompare(b.key),
	identityOfDelete: (entry) => ({ key: entry }),
	canonicalizeValues: (record) =>
		composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>) as RoleValues,
	toCreateEntry: (record) => record,
	toUpdateEntry: (identity, changes) => ({ key: identity.key, changes }),
	toDeleteEntry: (identity) => identity.key,
	handler: {
		readCurrent,
		projectReadState,
		validateDesired,
		postPlan: (plan) => ({ ...plan, update: administratorGrantsFirst(plan.update) }),
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
