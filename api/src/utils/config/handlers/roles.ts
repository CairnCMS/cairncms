import { PUBLIC_ROLE_KEY } from '@cairncms/constants';
import type {
	ApplyResult,
	ConfigRole,
	RoleDeletionImpactEntry,
	RoleFieldChanges,
	RoleIdentity,
	RoleValues,
} from '../../../types/config.js';
import { ROLE_ICON_MAX_LENGTH, ROLE_KEY_MAX_LENGTH, ROLE_NAME_MAX_LENGTH } from '../../config-contract.js';
import type {
	ConfigFieldDescriptor,
	ConfigResourceDescriptor,
	FieldSensitivity,
	NoConfigDependencies,
} from '../descriptor.js';
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
		omissionPreservesCurrent: false,
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
		omissionPreservesCurrent: false,
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
		omissionPreservesCurrent: false,
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
		omissionPreservesCurrent: false,
	},
];

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
	projectDocuments: (documents) => ({
		records: documents,
		anchors: documents.map((document) => ({ key: document.key })),
	}),
	composeDocuments: (records) => records,
	identityOf: (record) => ({ key: record.key }),
	identityKey: (identity) => JSON.stringify([identity.key]),
	identityOfDelete: (entry) => ({ key: entry }),
	canonicalizeValues: (record) =>
		composeValues(RECORD_FIELDS, record as unknown as Record<string, unknown>) as RoleValues,
	toCreateEntry: (record) => record,
	toUpdateEntry: (identity, changes) => ({ key: identity.key, changes }),
	toDeleteEntry: (identity) => identity.key,
	handler: createUnwiredHandler<RolesKindTypes>(),
};
