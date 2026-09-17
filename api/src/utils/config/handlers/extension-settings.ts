import {
	ExtensionSettingKeySchema,
	ExtensionSettingsSubjectSchema,
	getExtensionConfigSecretName,
} from '@cairncms/constants';
import type { ExtensionSettings } from '@cairncms/types';
import { createHash } from 'node:crypto';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import type { ExtensionSettingsService } from '../../../services/extension-settings.js';
import type {
	ConfigExtensionSettings,
	ConfigFailure,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ExtensionSettingLeaf,
	ExtensionSettingsFieldChanges,
	ExtensionSettingsIdentity,
	ExtensionSettingsValues,
} from '../../../types/config.js';
import { isSecretEnvelope } from '../../encrypt-secret.js';
import { safeLogFragment } from '../../safe-log-fragment.js';
import { CONFIG_FILENAME_STEM_MAX_LENGTH } from '../../config-contract.js';
import { interpolateEnvVar, isPlaceholder, PLACEHOLDER_NAMESPACE, placeholderVarName } from '../placeholder.js';
import type {
	ApplyContext,
	ConfigFieldDescriptor,
	ConfigReadMode,
	ConfigResourceDescriptor,
	ExtensionDeclarationSnapshot,
	FieldSensitivity,
	KindPlan,
	NoConfigDependencies,
	PlanContext,
	ReadContext,
	ReadCurrentResult,
	ReadStateProjection,
	ValidationContext,
} from '../descriptor.js';
import { checkSettingValue } from '../extension-settings-rules.js';
import { invalid, identityConflict } from '../failures.js';
import { unreadable } from '../read-parsing.js';
import { changesToValues, composeValues } from '../values.js';

const NON_SECRET: FieldSensitivity = { secret: false, redact: 'none' };

const TABLE = 'cairncms_extension_settings';
const GLOBAL_SCOPE = 'global';
const COLLECTION_SCOPE = 'collection';

/** Private envelope hash for rotation detection; excluded from plans, snapshots, and writes. */
type ExtensionSettingRecord = ExtensionSettingsIdentity & { value: ExtensionSettingLeaf; fingerprint?: string };

export interface ExtensionSettingsKindTypes {
	Kind: 'extension-settings';
	Document: ConfigExtensionSettings;
	Record: ExtensionSettingRecord;
	Values: ExtensionSettingsValues;
	Identity: ExtensionSettingsIdentity;
	DocumentIdentity: { subject: string };
	Create: { identity: ExtensionSettingsIdentity; value: ExtensionSettingLeaf };
	Update: { identity: ExtensionSettingsIdentity; changes: ExtensionSettingsFieldChanges };
	Delete: { identity: ExtensionSettingsIdentity };
	Changes: ExtensionSettingsFieldChanges;
	ReadDependencyState: { classification: string[] };
	ApplyDependencyState: undefined;
	ReadDependencies: NoConfigDependencies;
	PlanDependencies: NoConfigDependencies;
	ApplyDependencies: NoConfigDependencies;
	Enrichment: Record<never, never>;
	ResultSlice: { created: number; updated: number; deleted: number };
	Outcome: { op: 'create'; count: number } | { op: 'update'; count: number } | { op: 'delete'; count: number };
}

const SUBJECT_FIELD: ConfigFieldDescriptor = {
	name: 'subject',
	type: 'string',
	required: true,
	nullable: false,
	maxLength: 255,
	acceptsPlaceholder: false,
	sensitivity: NON_SECRET,
	snapshotSafe: true,
	mutable: false,
	omissionPreservesCurrent: false,
};

// This descriptor drives composition and diffing; the nested-map schema validates the actual leaf types.
const VALUE_FIELD: ConfigFieldDescriptor = {
	name: 'value',
	type: 'string',
	required: true,
	nullable: false,
	acceptsPlaceholder: false,
	sensitivity: NON_SECRET,
	snapshotSafe: true,
	mutable: true,
	omissionPreservesCurrent: false,
};

const RECORD_FIELDS: ConfigFieldDescriptor[] = [VALUE_FIELD];
const VALUE_FIELD_ORDER = ['value'] as const;

const PRESERVE_MARKER: ExtensionSettingLeaf = { $secret: 'preserve' };

function isPreserveMarker(value: unknown): value is { $secret: 'preserve' } {
	return typeof value === 'object' && value !== null && (value as Record<string, unknown>)['$secret'] === 'preserve';
}

function isExtReference(value: unknown): value is string {
	return typeof value === 'string' && /^\{\{CAIRNCMS_EXT_[A-Z0-9_]*\}\}$/.test(value);
}

function extReferenceFor(subject: string, key: string): string {
	return `{{${getExtensionConfigSecretName(subject, key)}}}`;
}

function isConfigPlaceholder(value: unknown): boolean {
	return isPlaceholder(value) && (placeholderVarName(value)?.startsWith(PLACEHOLDER_NAMESPACE) ?? false);
}

function interpolateLeaf(value: ExtensionSettingLeaf, subject: string, key: string): ExtensionSettingLeaf {
	if (!isConfigPlaceholder(value)) return value;

	return interpolateEnvVar(value as string, key, { label: 'extension settings for subject', value: subject });
}

function interpolateLeafMap(
	map: Record<string, ExtensionSettingLeaf>,
	subject: string
): Record<string, ExtensionSettingLeaf> {
	const out: Record<string, ExtensionSettingLeaf> = {};

	for (const [key, value] of Object.entries(map)) out[key] = interpolateLeaf(value, subject, key);

	return out;
}

function leafMapOf(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function restoreCommittedPlaceholders(
	pending: ConfigExtensionSettings,
	existing: Record<string, unknown>
): ConfigExtensionSettings {
	const restoreMap = (
		target: Record<string, ExtensionSettingLeaf>,
		source: Record<string, unknown>
	): Record<string, ExtensionSettingLeaf> => {
		const out: Record<string, ExtensionSettingLeaf> = { ...target };

		for (const key of Object.keys(out)) {
			const emitted = out[key];

			// An old placeholder must not override the emitted value's type or secret category.
			if (isConfigPlaceholder(source[key]) && typeof emitted === 'string' && !isExtReference(emitted)) {
				out[key] = source[key] as ExtensionSettingLeaf;
			}
		}

		return out;
	};

	const existingCollections = leafMapOf(existing['collections']);
	const collections: Record<string, Record<string, ExtensionSettingLeaf>> = {};

	for (const [collection, entries] of Object.entries(pending.collections)) {
		collections[collection] = restoreMap(entries, leafMapOf(existingCollections[collection]));
	}

	return {
		subject: pending.subject,
		global: restoreMap(pending.global, leafMapOf(existing['global'])),
		collections,
	};
}

// EXT references are portable values, not unresolved CLI placeholders.
function residualConfigPlaceholders(documents: ConfigExtensionSettings[]): string[] {
	const problems: string[] = [];

	const note = (subject: string, scope: string, scopeKey: string, key: string): void => {
		const at =
			scope === COLLECTION_SCOPE ? `${safeLogFragment(scopeKey)}/${safeLogFragment(key)}` : safeLogFragment(key);

		problems.push(`extension-settings "${safeLogFragment(subject)}/${at}" holds placeholder syntax`);
	};

	for (const document of documents) {
		for (const [key, value] of Object.entries(document.global ?? {})) {
			if (isConfigPlaceholder(value)) note(document.subject, GLOBAL_SCOPE, '', key);
		}

		for (const [collection, entries] of Object.entries(document.collections ?? {})) {
			for (const [key, value] of Object.entries(entries ?? {})) {
				if (isConfigPlaceholder(value)) note(document.subject, COLLECTION_SCOPE, collection, key);
			}
		}
	}

	return problems;
}

export async function buildExtensionDeclarationSnapshot(): Promise<ExtensionDeclarationSnapshot> {
	// Import lazily to keep the extension subsystem out of config registry initialization.
	const { getExtensionManager } = await import('../../../extensions.js');
	const manager = getExtensionManager();

	if (!manager.isSettingsDiscoveryComplete()) {
		return { discoveryComplete: false, eligible: new Map() };
	}

	const eligible = new Map<string, ExtensionSettings>();

	for (const owner of manager.getSettingsOwners()) {
		if (owner.status === 'available' && owner.subject !== undefined && owner.declaration !== undefined) {
			eligible.set(owner.subject, owner.declaration);
		}
	}

	return { discoveryComplete: true, eligible };
}

// Read scoping precedes validation; malformed entries are left for validation to reject.
export function desiredExtensionSubjects(documents: unknown): ReadonlySet<string> {
	const subjects = new Set<string>();

	if (!Array.isArray(documents)) return subjects;

	for (const document of documents) {
		const subject = (document as { subject?: unknown } | null)?.subject;
		if (typeof subject === 'string') subjects.add(subject);
	}

	return subjects;
}

function identityKeyOf(identity: ExtensionSettingsIdentity): string {
	return JSON.stringify([identity.subject, identity.scope, identity.scope_key, identity.key]);
}

function compareIdentity(a: ExtensionSettingsIdentity, b: ExtensionSettingsIdentity): number {
	return (
		a.subject.localeCompare(b.subject) ||
		a.scope.localeCompare(b.scope) ||
		a.scope_key.localeCompare(b.scope_key) ||
		a.key.localeCompare(b.key)
	);
}

function fingerprintOf(storedValue: string): string {
	return createHash('sha256').update(storedValue).digest('hex');
}

// Include unset keys so declaration changes invalidate the digest even without stored-row changes.
function declarationClassification(subjects: string[], eligible: ReadonlyMap<string, ExtensionSettings>): string[] {
	const entries: string[] = [];

	for (const subject of subjects) {
		const declaration = eligible.get(subject);
		if (declaration === undefined) continue;

		for (const [key, declared] of Object.entries(declaration)) {
			entries.push([subject, key, declared.scope, declared.type, declared.secret?.source ?? 'none'].join('\u0000'));
		}
	}

	return entries.sort();
}

async function readCurrent(
	context: ReadContext<ExtensionSettingsKindTypes>
): Promise<ReadCurrentResult<ExtensionSettingsKindTypes>> {
	const snapshot = context.extensionDeclarations ?? (await buildExtensionDeclarationSnapshot());

	if (!snapshot.discoveryComplete) {
		throw unreadable('extension settings', 'the settings declaration catalogue could not be established');
	}

	const scope = context.selectedExtensionSubjects;
	const eligibleSubjects = [...snapshot.eligible.keys()].filter((subject) => scope === undefined || scope.has(subject));

	// With no eligible subject in scope, every stored row is inert.
	if (eligibleSubjects.length === 0) {
		return { records: [], documentIdentities: [], dependencyState: { classification: [] } };
	}

	const records: ExtensionSettingRecord[] = [];
	// Retain empty subjects so clearing the last setting does not become "stop managing this subject".
	const subjects = new Set<string>(eligibleSubjects);

	if (context.readMode === 'full') {
		const query = context.database(TABLE).select('extension', 'scope', 'scope_key', 'key', 'value');
		if (scope !== undefined) query.whereIn('extension', eligibleSubjects);

		const rows = await query;

		for (const row of rows) {
			const subject = row['extension'] as string;
			const declaration = snapshot.eligible.get(subject);
			if (declaration === undefined || (scope !== undefined && !scope.has(subject))) continue; // inert: out of scope

			const declared = declaration[row['key'] as string];
			if (declared === undefined) continue; // inert: key no longer declared

			const storedScope = row['scope'] as string;

			if (storedScope !== declared.scope) {
				throw unreadable(
					`extension setting ${safeLogFragment(subject)}/${safeLogFragment(row['key'])}`,
					`is stored at scope "${safeLogFragment(storedScope)}" but declared at "${declared.scope}"`
				);
			}

			if (declared.secret !== undefined && declared.secret.source === 'config') continue; // config-sourced is never a stored row

			const storedValue = row['value'] as string;
			let parsed: unknown;

			try {
				parsed = JSON.parse(storedValue);
			} catch {
				throw unreadable(
					`extension setting ${safeLogFragment(subject)}/${safeLogFragment(row['key'])}`,
					'did not read as valid JSON'
				);
			}

			const identity: ExtensionSettingsIdentity = {
				subject,
				scope: storedScope === COLLECTION_SCOPE ? COLLECTION_SCOPE : GLOBAL_SCOPE,
				scope_key: row['scope_key'] as string,
				key: row['key'] as string,
			};

			if (declared.secret !== undefined) {
				if (!isSecretEnvelope(parsed)) {
					throw unreadable(
						`extension setting ${safeLogFragment(subject)}/${safeLogFragment(row['key'])}`,
						'is declared secret but its stored value is not an encrypted envelope'
					);
				}

				records.push({ ...identity, value: PRESERVE_MARKER, fingerprint: fingerprintOf(storedValue) });
				continue;
			}

			if (typeof parsed !== declared.type) {
				throw unreadable(
					`extension setting ${safeLogFragment(subject)}/${safeLogFragment(row['key'])}`,
					`holds a value that does not match the declared type "${declared.type}"`
				);
			}

			if (isExtReference(parsed)) {
				throw unreadable(
					`extension setting ${safeLogFragment(subject)}/${safeLogFragment(row['key'])}`,
					'is an ordinary value that is a reserved runtime-reference expression'
				);
			}

			records.push({ ...identity, value: parsed as ExtensionSettingLeaf });
		}
	}

	// Config-sourced references are emitted from the declaration, whether or not a row exists (they are never stored).
	for (const subject of eligibleSubjects) {
		const declaration = snapshot.eligible.get(subject)!;

		for (const [key, declared] of Object.entries(declaration)) {
			if (declared.secret === undefined || declared.secret.source !== 'config') continue;

			records.push({
				subject,
				scope: declared.scope === COLLECTION_SCOPE ? COLLECTION_SCOPE : GLOBAL_SCOPE,
				scope_key: '',
				key,
				value: extReferenceFor(subject, key),
			});
		}
	}

	records.sort(compareIdentity);

	return {
		records,
		documentIdentities: [...subjects].sort().map((subject) => ({ subject })),
		dependencyState: { classification: declarationClassification(eligibleSubjects, snapshot.eligible) },
	};
}

const CLASSIFICATION_DIGEST_KEY = '\u0000declaration-classification';

function projectReadState(
	result: ReadCurrentResult<ExtensionSettingsKindTypes>,
	mode: ConfigReadMode
): ReadStateProjection {
	const identities = result.records.map((record) => identityKeyOf(record)).sort();

	if (mode === 'identity') return { mode, identities };

	const values = result.records
		.map((record): [string, unknown] => [
			identityKeyOf(record),
			record.fingerprint !== undefined
				? { value: record.value, fingerprint: record.fingerprint }
				: composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>),
		])
		.sort((a, b) => a[0].localeCompare(b[0]));

	values.push([CLASSIFICATION_DIGEST_KEY, result.dependencyState.classification]);

	return { mode, identities, values };
}

function validateDesired(
	documents: ConfigExtensionSettings[],
	_records: ExtensionSettingRecord[],
	context: ValidationContext
): ConfigFailure[] {
	const failures: ConfigFailure[] = [];
	const seenSubjects = new Set<string>();

	for (const document of documents) {
		const subject = document.subject;
		const subjectLabel = safeLogFragment(subject);

		if (!ExtensionSettingsSubjectSchema.safeParse(subject).success) {
			failures.push(invalid(`Extension settings subject "${subjectLabel}" is not a valid extension package name.`));
			continue;
		}

		if (seenSubjects.has(subject)) {
			failures.push(identityConflict(`Duplicate extension settings for subject "${subjectLabel}".`));
		}

		seenSubjects.add(subject);

		if (context.references === 'server-snapshot') continue; // portable structure only, no local catalogue

		const declaration = context.extensionDeclarations?.eligible.get(subject);

		if (declaration === undefined) {
			failures.push(
				invalid(`Extension settings subject "${subjectLabel}" is not installed or eligible on the target.`)
			);

			continue;
		}

		validateEntries(failures, subject, subjectLabel, GLOBAL_SCOPE, document.global, declaration, context);

		for (const [collection, entries] of Object.entries(document.collections ?? {})) {
			if (context.currentCollections !== undefined && !context.currentCollections.has(collection)) {
				failures.push(
					invalid(
						`Extension settings for "${subjectLabel}" target collection "${safeLogFragment(
							collection
						)}", which does not exist.`
					)
				);
			}

			validateEntries(failures, subject, subjectLabel, COLLECTION_SCOPE, entries, declaration, context);
		}
	}

	return failures;
}

function validateEntries(
	failures: ConfigFailure[],
	subject: string,
	subjectLabel: string,
	scope: string,
	entries: Record<string, ExtensionSettingLeaf> | undefined,
	declaration: ExtensionSettings,
	_context: ValidationContext
): void {
	for (const [key, value] of Object.entries(entries ?? {})) {
		const keyLabel = safeLogFragment(key);

		if (!ExtensionSettingKeySchema.safeParse(key).success) {
			failures.push(invalid(`Extension setting "${subjectLabel}/${keyLabel}" is not a valid setting key.`));
			continue;
		}

		const declared = declaration[key];

		if (declared === undefined) {
			failures.push(invalid(`Extension setting "${subjectLabel}/${keyLabel}" is not declared by the extension.`));
			continue;
		}

		if (declared.scope !== scope) {
			failures.push(
				invalid(
					`Extension setting "${subjectLabel}/${keyLabel}" is declared at "${declared.scope}" scope, not "${scope}".`
				)
			);

			continue;
		}

		if (declared.secret !== undefined && declared.secret.source === 'config') {
			if (value !== extReferenceFor(subject, key)) {
				failures.push(
					invalid(`Config-sourced secret "${subjectLabel}/${keyLabel}" must be its exact runtime reference.`)
				);
			}

			continue;
		}

		if (declared.secret !== undefined) {
			if (!isPreserveMarker(value)) {
				failures.push(invalid(`Inline secret "${subjectLabel}/${keyLabel}" only accepts "$secret: preserve".`));
			}

			continue;
		}

		if (isExtReference(value)) {
			failures.push(
				invalid(`Extension setting "${subjectLabel}/${keyLabel}" must not use a runtime-reference expression.`)
			);

			continue;
		}

		if (isPreserveMarker(value) || checkSettingValue(declared.type, value) !== undefined) {
			failures.push(invalid(`Extension setting "${subjectLabel}/${keyLabel}" must be a ${declared.type}.`));
		}
	}
}

// Document presence selects managed subjects; preserve markers and runtime references do not mutate storage.
function postPlan(
	plan: KindPlan<ExtensionSettingsKindTypes>,
	context: PlanContext<ExtensionSettingsKindTypes>
): KindPlan<ExtensionSettingsKindTypes> {
	const desiredSubjects = context.desiredSubjects ?? new Set<string>();
	const declarations = context.extensionDeclarations;

	const isConfigSourced = (identity: ExtensionSettingsIdentity): boolean => {
		const declared = declarations?.eligible.get(identity.subject)?.[identity.key];
		return declared?.secret?.source === 'config';
	};

	const managed = (identity: ExtensionSettingsIdentity): boolean =>
		desiredSubjects.has(identity.subject) && !isConfigSourced(identity);

	return {
		create: plan.create.filter((entry) => managed(entry.identity) && !isPreserveMarker(entry.value)),
		update: plan.update.filter((entry) => managed(entry.identity) && !isPreserveMarker(entry.changes.value?.after)),
		delete: plan.delete.filter((entry) => managed(entry.identity)),
	};
}

async function enrich(): Promise<ExtensionSettingsKindTypes['Enrichment']> {
	return {};
}

function emptyEnrichment(): ExtensionSettingsKindTypes['Enrichment'] {
	return {};
}

function toChanges(plan: KindPlan<ExtensionSettingsKindTypes>, _enrichment: ConfigPlanEnrichment): ConfigPlanChange[] {
	const changes: ConfigPlanChange[] = [];

	for (const create of plan.create) {
		changes.push({
			kind: 'extension-settings',
			operation: 'create',
			identity: create.identity,
			values: { value: create.value },
		});
	}

	for (const update of plan.update) {
		changes.push({
			kind: 'extension-settings',
			operation: 'update',
			identity: update.identity,
			fields: update.changes,
		});
	}

	for (const del of plan.delete) {
		changes.push({ kind: 'extension-settings', operation: 'delete', identity: del.identity, impact: [] });
	}

	return changes;
}

async function serviceFor(context: ApplyContext<ExtensionSettingsKindTypes>): Promise<ExtensionSettingsService> {
	const { ExtensionSettingsService } = await import('../../../services/extension-settings.js');

	return new ExtensionSettingsService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});
}

function declaredFor(
	context: ApplyContext<ExtensionSettingsKindTypes>,
	identity: ExtensionSettingsIdentity
): { type: string; scope: string; secret?: { source: 'inline' | 'config' } | undefined } {
	const declared = context.extensionDeclarations?.eligible.get(identity.subject)?.[identity.key];

	if (declared === undefined) {
		throw new ConfigInvalidException(
			`Extension setting "${safeLogFragment(identity.subject)}/${safeLogFragment(identity.key)}" is no longer declared.`
		);
	}

	return declared;
}

async function applyCreates(
	creates: ExtensionSettingsKindTypes['Create'][],
	context: ApplyContext<ExtensionSettingsKindTypes>
): Promise<Extract<ExtensionSettingsKindTypes['Outcome'], { op: 'create' }>> {
	const service = await serviceFor(context);
	let count = 0;

	for (const { identity, value } of creates) {
		await service.applyForConfig({
			operation: 'create',
			subject: identity.subject,
			scope: identity.scope,
			scopeKey: identity.scope_key,
			key: identity.key,
			value,
			declared: declaredFor(context, identity),
		});

		count++;
	}

	return { op: 'create', count };
}

async function applyUpdates(
	updates: ExtensionSettingsKindTypes['Update'][],
	context: ApplyContext<ExtensionSettingsKindTypes>
): Promise<Extract<ExtensionSettingsKindTypes['Outcome'], { op: 'update' }>> {
	const service = await serviceFor(context);
	let count = 0;

	for (const { identity, changes } of updates) {
		const value = changesToValues(changes)['value'] as ExtensionSettingLeaf;

		await service.applyForConfig({
			operation: 'update',
			subject: identity.subject,
			scope: identity.scope,
			scopeKey: identity.scope_key,
			key: identity.key,
			value,
			declared: declaredFor(context, identity),
		});

		count++;
	}

	return { op: 'update', count };
}

async function applyDeletes(
	deletes: ExtensionSettingsKindTypes['Delete'][],
	context: ApplyContext<ExtensionSettingsKindTypes>
): Promise<Extract<ExtensionSettingsKindTypes['Outcome'], { op: 'delete' }>> {
	const service = await serviceFor(context);
	let count = 0;

	for (const { identity } of deletes) {
		await service.applyForConfig({
			operation: 'delete',
			subject: identity.subject,
			scope: identity.scope,
			scopeKey: identity.scope_key,
			key: identity.key,
			declared: declaredFor(context, identity),
		});

		count++;
	}

	return { op: 'delete', count };
}

async function readApplyDependencyState(): Promise<ExtensionSettingsKindTypes['ApplyDependencyState']> {
	return undefined;
}

function emptyResult(): ExtensionSettingsKindTypes['ResultSlice'] {
	return { created: 0, updated: 0, deleted: 0 };
}

function mergeOutcome(
	slice: ExtensionSettingsKindTypes['ResultSlice'],
	outcome: ExtensionSettingsKindTypes['Outcome']
): ExtensionSettingsKindTypes['ResultSlice'] {
	switch (outcome.op) {
		case 'create':
			return { ...slice, created: slice.created + outcome.count };
		case 'update':
			return { ...slice, updated: slice.updated + outcome.count };
		case 'delete':
			return { ...slice, deleted: slice.deleted + outcome.count };
	}
}

const STEM_HASH_LENGTH = 8;
const STEM_SLUG_MAX_LENGTH = CONFIG_FILENAME_STEM_MAX_LENGTH - STEM_HASH_LENGTH - 1;

const DERIVED_STEM = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?[0-9a-f]{8}$/;

function filenameStemFor(subject: string): string {
	const slug = subject
		.replace(/^@/, '')
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase()
		.slice(0, STEM_SLUG_MAX_LENGTH)
		.replace(/-+$/g, '');

	const hash = createHash('sha256').update(subject).digest('hex').slice(0, STEM_HASH_LENGTH);
	return slug === '' ? hash : `${slug}-${hash}`;
}

function ownsFilenameStem(stem: string): boolean {
	return stem.length <= CONFIG_FILENAME_STEM_MAX_LENGTH && DERIVED_STEM.test(stem);
}

const YAML_SUFFIX = '.yaml';

export const extensionSettingsDescriptor: ConfigResourceDescriptor<ExtensionSettingsKindTypes> = {
	kind: 'extension-settings' as const,
	formatVersion: 2,
	dependencies: [] as [],
	layout: {
		directory: 'extension-settings',
		documentShape: { nestedMap: { globalField: 'global', collectionsField: 'collections' } },
		documentIdentityOf: (document: ConfigExtensionSettings) => ({ subject: document.subject }),
		filenameOf: (documentIdentity: { subject: string }) => filenameStemFor(documentIdentity.subject),
		ownsFilenameStem,
		parseDocumentFile: (record: Record<string, unknown>, filename: string) => {
			const subject = record['subject'];

			if (typeof subject !== 'string' || subject === '') {
				throw new ConfigInvalidException(
					`Extension settings file "${safeLogFragment(filename)}" is missing a "subject".`
				);
			}

			// Dropping a misspelled map name would turn its values into planned deletions.
			const unknown = Object.keys(record).find(
				(field) => field !== 'subject' && field !== 'global' && field !== 'collections'
			);

			if (unknown !== undefined) {
				throw new ConfigInvalidException(
					`Extension settings file "${safeLogFragment(filename)}" has an unknown field "${safeLogFragment(unknown)}".`
				);
			}

			if (
				record['global'] !== undefined &&
				(typeof record['global'] !== 'object' || record['global'] === null || Array.isArray(record['global']))
			) {
				throw new ConfigInvalidException(
					`Extension settings file "${safeLogFragment(filename)}" has a non-map "global".`
				);
			}

			if (
				record['collections'] !== undefined &&
				(typeof record['collections'] !== 'object' ||
					record['collections'] === null ||
					Array.isArray(record['collections']))
			) {
				throw new ConfigInvalidException(
					`Extension settings file "${safeLogFragment(filename)}" has a non-map "collections".`
				);
			}

			const expected = `${filenameStemFor(subject)}${YAML_SUFFIX}`;

			if (filename !== expected) {
				throw new ConfigInvalidException(
					`Extension settings file "${safeLogFragment(filename)}" holds subject "${safeLogFragment(
						subject
					)}"; filename must be "${safeLogFragment(expected)}".`
				);
			}

			const globalMap = (record['global'] as Record<string, ExtensionSettingLeaf>) ?? {};
			const collectionsMap = (record['collections'] as Record<string, Record<string, ExtensionSettingLeaf>>) ?? {};

			const collections: Record<string, Record<string, ExtensionSettingLeaf>> = {};

			for (const [collection, entries] of Object.entries(collectionsMap)) {
				// Coercing a malformed entry to an empty map would delete its stored settings.
				if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
					throw new ConfigInvalidException(
						`Extension settings file "${safeLogFragment(filename)}" collection "${safeLogFragment(
							collection
						)}" is not a map.`
					);
				}

				collections[collection] = interpolateLeafMap(entries, subject);
			}

			return {
				subject,
				global: interpolateLeafMap(globalMap, subject),
				collections,
			} satisfies ConfigExtensionSettings;
		},
	},
	documentIdentityFields: [SUBJECT_FIELD],
	recordFields: RECORD_FIELDS,
	valueFieldOrder: VALUE_FIELD_ORDER,
	emittedDocumentSubject: (identity: { subject: string }) => ({
		label: 'extension settings for subject',
		value: identity.subject,
	}),
	projectDocuments: (documents: ConfigExtensionSettings[]) => {
		const records: ExtensionSettingRecord[] = [];

		for (const document of documents) {
			for (const [key, value] of Object.entries(document.global ?? {})) {
				records.push({ subject: document.subject, scope: GLOBAL_SCOPE, scope_key: '', key, value });
			}

			for (const [collection, entries] of Object.entries(document.collections ?? {})) {
				for (const [key, value] of Object.entries(entries ?? {})) {
					records.push({ subject: document.subject, scope: COLLECTION_SCOPE, scope_key: collection, key, value });
				}
			}
		}

		return { records, anchors: documents.map((document) => ({ subject: document.subject })) };
	},
	composeDocuments: (records: ExtensionSettingRecord[], anchors: { subject: string }[]): ConfigExtensionSettings[] => {
		const bySubject = new Map<string, ConfigExtensionSettings>();

		for (const anchor of anchors) {
			bySubject.set(anchor.subject, { subject: anchor.subject, global: {}, collections: {} });
		}

		for (const record of records) {
			const doc = bySubject.get(record.subject) ?? { subject: record.subject, global: {}, collections: {} };
			bySubject.set(record.subject, doc);

			if (record.scope === COLLECTION_SCOPE) {
				(doc.collections[record.scope_key] ??= {})[record.key] = record.value;
			} else {
				doc.global[record.key] = record.value;
			}
		}

		return anchors.map((anchor) => bySubject.get(anchor.subject)!);
	},
	identityOf: (record: ExtensionSettingRecord): ExtensionSettingsIdentity => ({
		subject: record.subject,
		scope: record.scope,
		scope_key: record.scope_key,
		key: record.key,
	}),
	identityKey: identityKeyOf,
	compareIdentity,
	identityOfDelete: (entry: { identity: ExtensionSettingsIdentity }) => entry.identity,
	canonicalizeValues: (record: ExtensionSettingRecord) =>
		composeValues(
			RECORD_FIELDS,
			VALUE_FIELD_ORDER,
			record as unknown as Record<string, unknown>
		) as ExtensionSettingsValues,
	residualPlaceholders: residualConfigPlaceholders,
	restorePlaceholders: restoreCommittedPlaceholders,
	toCreateEntry: (record: ExtensionSettingRecord) => ({
		identity: { subject: record.subject, scope: record.scope, scope_key: record.scope_key, key: record.key },
		value: record.value,
	}),
	toUpdateEntry: (identity: ExtensionSettingsIdentity, changes: ExtensionSettingsFieldChanges) => ({
		identity,
		changes,
	}),
	toDeleteEntry: (identity: ExtensionSettingsIdentity) => ({ identity }),
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
