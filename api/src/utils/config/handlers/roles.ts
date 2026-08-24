import { PUBLIC_ROLE_ID, PUBLIC_ROLE_KEY } from '@cairncms/constants';
import { normalizeRoleKey } from '@cairncms/utils';
import { RolesService } from '../../../services/roles.js';
import type {
	ApplyResult,
	ConfigFailure,
	ConfigRole,
	RoleDeletionImpactEntry,
	RoleFieldChanges,
	RoleIdentity,
	RoleValues,
} from '../../../types/config.js';
import { ROLE_ICON_MAX_LENGTH, ROLE_KEY_MAX_LENGTH, ROLE_NAME_MAX_LENGTH } from '../../config-contract.js';
import { safeLogFragment } from '../../safe-log-fragment.js';
import type {
	ConfigFieldDescriptor,
	ConfigResourceDescriptor,
	FieldSensitivity,
	NoConfigDependencies,
	ReadContext,
} from '../descriptor.js';
import { identityConflict } from '../failures.js';
import { UNFILTERED, assertStringArray, parseStoredCSV, unreadable } from '../read-parsing.js';
import { createUnwiredHandler } from '../stub-handler.js';
import { composeValues, sortedOrNull } from '../values.js';

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

export const rolesDescriptor: ConfigResourceDescriptor<RolesKindTypes> = {
	kind: 'roles',
	formatVersion: 1,
	dependencies: [],
	layout: {
		directory: 'roles',
		documentShape: 'flat',
		documentIdentityOf: (document) => ({ key: document.key }),
		filenameOf: (documentIdentity) => documentIdentity.key,
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
	identityOfDelete: (entry) => ({ key: entry }),
	canonicalizeValues: (record) =>
		composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>) as RoleValues,
	toCreateEntry: (record) => record,
	toUpdateEntry: (identity, changes) => ({ key: identity.key, changes }),
	toDeleteEntry: (identity) => identity.key,
	handler: { ...createUnwiredHandler<RolesKindTypes>(), readCurrent, validateDesired },
};
