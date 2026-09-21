import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import { SettingsService } from '../../../services/settings.js';
import type {
	ConfigFailure,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigSettings,
	SettingsFieldChanges,
	SettingsIdentity,
	SettingsValues,
} from '../../../types/config.js';
import { CONFIG_FILENAME_STEM_MAX_LENGTH } from '../../config-contract.js';
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
	ValidationContext,
} from '../descriptor.js';
import { invalid } from '../failures.js';
import { resolveFolderReference } from '../folder-id-lookup.js';
import { interpolatePlaceholderFields } from '../placeholder.js';
import { UNFILTERED, unreadable } from '../read-parsing.js';
import { changesToValues, composeValues } from '../values.js';
import type { FoldersKindTypes } from './folders.js';

const NON_SECRET: FieldSensitivity = { secret: false, redact: 'none' };

const SETTINGS_STEM = 'project';

export interface SettingsKindTypes {
	Kind: 'settings';
	Document: ConfigSettings;
	Record: ConfigSettings;
	Values: SettingsValues;
	Identity: SettingsIdentity;
	DocumentIdentity: SettingsIdentity;
	Create: never;
	Update: { changes: SettingsFieldChanges };
	Delete: never;
	Changes: SettingsFieldChanges;
	ReadDependencyState: Record<never, never>;
	ApplyDependencyState: Record<never, never>;
	ReadDependencies: { folders: FoldersKindTypes['ReadDependencyState'] };
	PlanDependencies: NoConfigDependencies;
	ApplyDependencies: { folders: FoldersKindTypes['ApplyDependencyState'] };
	Enrichment: Record<never, never>;
	ResultSlice: { updated: string[] };
	Outcome: { op: 'update'; updated: string[] };
}

const FIELD_BASE = {
	required: false,
	acceptsPlaceholder: false,
	sensitivity: NON_SECRET,
	snapshotSafe: true,
	mutable: true,
	omissionPreservesCurrent: true,
} as const;

const RECORD_FIELDS: ConfigFieldDescriptor[] = [
	{
		...FIELD_BASE,
		name: 'project_name',
		type: 'string',
		nullable: false,
		allowEmpty: true,
		maxLength: 100,
		acceptsPlaceholder: true,
	},
	{
		...FIELD_BASE,
		name: 'project_descriptor',
		type: 'string',
		nullable: true,
		allowEmpty: true,
		maxLength: 100,
		acceptsPlaceholder: true,
	},
	{
		...FIELD_BASE,
		name: 'project_url',
		type: 'string',
		nullable: true,
		allowEmpty: true,
		maxLength: 255,
		acceptsPlaceholder: true,
	},
	{ ...FIELD_BASE, name: 'default_language', type: 'string', nullable: false, allowEmpty: true, maxLength: 255 },
	{ ...FIELD_BASE, name: 'project_color', type: 'string', nullable: true, allowEmpty: true, maxLength: 50 },
	{ ...FIELD_BASE, name: 'public_note', type: 'string', nullable: true, allowEmpty: true },
	{ ...FIELD_BASE, name: 'custom_css', type: 'string', nullable: true, allowEmpty: true },
	{ ...FIELD_BASE, name: 'module_bar', type: 'json-array', arrayItems: 'record', nullable: true },
	{ ...FIELD_BASE, name: 'auth_password_policy', type: 'string', nullable: true, allowEmpty: true, maxLength: 100 },
	{ ...FIELD_BASE, name: 'auth_login_attempts', type: 'number', nullable: true, min: 0 },
	{ ...FIELD_BASE, name: 'storage_asset_transform', type: 'string', nullable: true, enum: ['all', 'none', 'presets'] },
	{ ...FIELD_BASE, name: 'storage_asset_presets', type: 'json-array', arrayItems: 'record', nullable: true },
	{ ...FIELD_BASE, name: 'basemaps', type: 'json-array', arrayItems: 'record', nullable: true },
	{ ...FIELD_BASE, name: 'custom_aspect_ratios', type: 'json-array', arrayItems: 'record', nullable: true },
	{
		...FIELD_BASE,
		name: 'mapbox_key',
		type: 'string',
		nullable: true,
		allowEmpty: true,
		maxLength: 255,
		acceptsPlaceholder: true,
	},
	{
		...FIELD_BASE,
		name: 'storage_default_folder',
		type: 'string',
		nullable: true,
		grammar: 'config-key',
		maxLength: CONFIG_FILENAME_STEM_MAX_LENGTH,
		canonicalize: (value) => value ?? null,
	},
];

const VALUE_FIELD_ORDER = [
	'project_name',
	'project_descriptor',
	'project_url',
	'default_language',
	'project_color',
	'public_note',
	'custom_css',
	'module_bar',
	'auth_password_policy',
	'auth_login_attempts',
	'storage_asset_transform',
	'storage_asset_presets',
	'basemaps',
	'custom_aspect_ratios',
	'mapbox_key',
	'storage_default_folder',
] as const;

/**
 * readSingleton omits a column whose default is null and returns an existing row unchanged. On an empty table the
 * omitted columns are materialized as null. On an existing row an absent column is an incomplete read, not a null.
 */
function readField(source: Record<string, unknown>, field: ConfigFieldDescriptor, rowExists: boolean): unknown {
	let value = source[field.name];

	if (value === undefined) {
		if (rowExists) {
			throw unreadable('project settings', `column "${field.name}" was absent from the row, so the read is incomplete`);
		}

		value = null;
	}

	if (field.type === 'json-array' && value !== null && !Array.isArray(value)) {
		throw unreadable('project settings', `column "${field.name}" did not read as a JSON array`);
	}

	return value;
}

function buildRecord(source: Record<string, unknown>, rowExists: boolean): ConfigSettings {
	const record: Record<string, unknown> = {};

	for (const field of RECORD_FIELDS) {
		record[field.name] = readField(source, field, rowExists);
	}

	return record as ConfigSettings;
}

async function readCurrent(context: ReadContext<SettingsKindTypes>): Promise<ReadCurrentResult<SettingsKindTypes>> {
	const documentIdentities: SettingsIdentity[] = [{ key: SETTINGS_STEM }];

	if (context.readMode === 'identity') {
		return { records: [], documentIdentities, dependencyState: {} };
	}

	const settingsService = new SettingsService({ knex: context.database, schema: context.schema });
	const source = (await settingsService.readSingleton({ fields: ['*'] }, UNFILTERED)) as Record<string, unknown>;

	// readSingleton returns the identity as an explicit null for an empty table and the real key for an existing row.
	// An absent identity is an incomplete read, not an empty table, so it must fail closed rather than materialize nulls.
	if (source['id'] === undefined) {
		throw unreadable('project settings', 'the read did not return the identity column, so it is incomplete');
	}

	const rowExists = source['id'] !== null;
	const record = buildRecord(source, rowExists);
	const storedFolderId = record.storage_default_folder;

	if (storedFolderId !== null && storedFolderId !== undefined) {
		const folderKey = await resolveFolderReference(
			context.database,
			context.dependency('folders').folderKeyById,
			storedFolderId
		);

		if (folderKey === undefined) {
			throw unreadable('project settings', 'column "storage_default_folder" points to an unknown folder');
		}

		record.storage_default_folder = folderKey;
	}

	return { records: [record], documentIdentities, dependencyState: {} };
}

function projectReadState(result: ReadCurrentResult<SettingsKindTypes>, mode: ConfigReadMode): ReadStateProjection {
	if (mode === 'identity') {
		return { mode, identities: [SETTINGS_STEM] };
	}

	const record = result.records[0]!;
	const values = composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>);

	return { mode, identities: [SETTINGS_STEM], values: [[SETTINGS_STEM, values]] };
}

function validateDesired(
	documents: ConfigSettings[],
	_records: ConfigSettings[],
	context: ValidationContext
): ConfigFailure[] {
	if (documents.length !== 1) {
		return [invalid(`Project settings must declare exactly one record, but found ${documents.length}.`)];
	}

	const reference = documents[0]!.storage_default_folder;

	if (typeof reference !== 'string') return [];

	const subject = safeLogFragment(reference);

	if (context.foldersManaged) {
		if (!context.declaredFolderKeys.has(reference)) {
			return [invalid(`Project settings references default folder "${subject}", which no folder file declares.`)];
		}

		return [];
	}

	switch (context.references) {
		case 'current-state':
			if (!context.currentFolderKeys.has(reference)) {
				return [
					invalid(`Project settings references default folder "${subject}", which does not exist in the database.`),
				];
			}

			return [];
		case 'server-snapshot':
			return [];

		default: {
			const unsupported: never = context;
			throw new Error(`Unsupported folder reference source: ${JSON.stringify(unsupported)}`);
		}
	}
}

async function enrich(
	_plan: KindPlan<SettingsKindTypes>,
	_records: ConfigSettings[],
	_context: EnrichContext
): Promise<SettingsKindTypes['Enrichment']> {
	return {};
}

function emptyEnrichment(): SettingsKindTypes['Enrichment'] {
	return {};
}

function toChanges(plan: KindPlan<SettingsKindTypes>, _enrichment: ConfigPlanEnrichment): ConfigPlanChange[] {
	return plan.update.map((update) => ({
		kind: 'settings' as const,
		operation: 'update' as const,
		identity: { key: SETTINGS_STEM },
		fields: update.changes,
	}));
}

async function applyUpdates(
	updates: SettingsKindTypes['Update'][],
	context: ApplyContext<SettingsKindTypes>
): Promise<Extract<SettingsKindTypes['Outcome'], { op: 'update' }>> {
	const updated: string[] = [];
	if (updates.length === 0) return { op: 'update', updated };

	const settingsService = new SettingsService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});

	const { folderIdByKey } = context.dependency('folders');

	const folderIdFor = (key: string): string => {
		const id = folderIdByKey.get(key);
		if (id === undefined) throw new Error(`Folder "${key}" not found during settings apply.`);
		return id;
	};

	for (const update of updates) {
		const values = changesToValues(update.changes);

		if (Object.hasOwn(values, 'storage_default_folder')) {
			const folderKey = values['storage_default_folder'];
			values['storage_default_folder'] = folderKey === null ? null : folderIdFor(folderKey as string);
		}

		await settingsService.upsertSingleton(values, context.mutationOptions);
		updated.push(SETTINGS_STEM);
	}

	return { op: 'update', updated };
}

async function applyCreates(
	_creates: SettingsKindTypes['Create'][],
	_context: ApplyContext<SettingsKindTypes>
): Promise<Extract<SettingsKindTypes['Outcome'], { op: 'create' }>> {
	throw new Error('Project settings is a singleton and cannot be created through config apply.');
}

async function applyDeletes(
	_deletes: SettingsKindTypes['Delete'][],
	_context: ApplyContext<SettingsKindTypes>
): Promise<Extract<SettingsKindTypes['Outcome'], { op: 'delete' }>> {
	throw new Error('Project settings is a singleton and cannot be deleted through config apply.');
}

async function readApplyDependencyState(
	_context: ApplyContext<SettingsKindTypes>
): Promise<SettingsKindTypes['ApplyDependencyState']> {
	return {};
}

function emptyResult(): SettingsKindTypes['ResultSlice'] {
	return { updated: [] };
}

function mergeOutcome(
	slice: SettingsKindTypes['ResultSlice'],
	outcome: SettingsKindTypes['Outcome']
): SettingsKindTypes['ResultSlice'] {
	return { updated: [...slice.updated, ...outcome.updated] };
}

export const settingsDescriptor: ConfigResourceDescriptor<SettingsKindTypes> = {
	kind: 'settings',
	formatVersion: 2,
	dependencies: ['folders'],
	layout: {
		directory: 'settings',
		documentShape: { singleton: { filename: SETTINGS_STEM } },
		documentIdentityOf: () => ({ key: SETTINGS_STEM }),
		filenameOf: () => SETTINGS_STEM,
		parseDocumentFile: (record, filename) => {
			const expected = `${SETTINGS_STEM}.yaml`;

			if (filename !== expected) {
				throw new ConfigInvalidException(
					`Project settings must be stored in "${expected}", not "${safeLogFragment(filename)}".`
				);
			}

			return interpolatePlaceholderFields(RECORD_FIELDS, record, {
				label: 'project settings',
				value: SETTINGS_STEM,
			}) as unknown as ConfigSettings;
		},
	},
	documentIdentityFields: [],
	recordFields: RECORD_FIELDS,
	valueFieldOrder: VALUE_FIELD_ORDER,
	emittedDocumentSubject: (identity) => ({ label: 'project settings', value: identity.key }),
	projectDocuments: (documents) => ({ records: documents, anchors: documents.map(() => ({ key: SETTINGS_STEM })) }),
	composeDocuments: (records) => records,
	identityOf: () => ({ key: SETTINGS_STEM }),
	identityKey: (identity) => JSON.stringify([identity.key]),
	compareIdentity: (a, b) => a.key.localeCompare(b.key),
	identityOfDelete: () => {
		throw new Error('Project settings has no delete operation.');
	},
	canonicalizeValues: (record) =>
		composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>) as SettingsValues,
	toCreateEntry: () => {
		throw new Error('Project settings is a singleton and cannot be created through config apply.');
	},
	toUpdateEntry: (_identity, changes) => ({ changes }),
	toDeleteEntry: () => {
		throw new Error('Project settings is a singleton and cannot be deleted through config apply.');
	},
	handler: {
		readCurrent,
		projectReadState,
		validateDesired,
		postPlan: (plan) => plan,
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
