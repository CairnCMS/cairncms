import type { PermissionsAction } from '@cairncms/types';
import type {
	ApplyResult,
	ConfigPermission,
	ConfigPermissionSet,
	ConfigPlanWarning,
	PermissionFieldChanges,
	PermissionIdentity,
	PermissionValues,
} from '../../../types/config.js';
import { PERMISSION_COLLECTION_MAX_LENGTH, ROLE_KEY_MAX_LENGTH, SUPPORTED_ACTIONS } from '../../config-contract.js';
import type { ConfigFieldDescriptor, ConfigResourceDescriptor, FieldSensitivity, KindPlan } from '../descriptor.js';
import { createUnwiredHandler } from '../stub-handler.js';
import { composeValues, sortedOrNull } from '../values.js';
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
	ResultSlice: ApplyResult['permissions'];
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

export const permissionsDescriptor: ConfigResourceDescriptor<PermissionsKindTypes> = {
	kind: 'permissions',
	formatVersion: 1,
	dependencies: ['roles'],
	layout: {
		directory: 'permissions',
		documentShape: { recordsField: 'permissions' },
		documentIdentityOf: (document) => ({ role: document.role }),
		filenameOf: (documentIdentity) => documentIdentity.role,
	},
	documentIdentityFields: [ROLE_FIELD],
	recordFields: RECORD_FIELDS,
	valueFieldOrder: VALUE_FIELD_ORDER,
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
	handler: createUnwiredHandler<PermissionsKindTypes>(),
};
