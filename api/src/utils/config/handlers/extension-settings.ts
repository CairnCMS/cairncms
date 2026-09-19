import {
	ExtensionSettingKeySchema,
	ExtensionSettingsSubjectSchema,
	getExtensionConfigSecretName,
} from '@cairncms/constants';
import type { ExtensionSettings } from '@cairncms/types';
import { createHash } from 'node:crypto';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../../../exceptions/config-read-failed.js';
import type { ExtensionSettingsService } from '../../../services/extension-settings.js';
import type {
	ConfigExtensionSettings,
	ConfigExtensionSettingsAuthored,
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
import { checkSettingScope, checkSettingValue, type SettingScopeProblem } from '../extension-settings-rules.js';
import { EXTENSION_SETTING_LEAF_SCHEMA } from '../field-schema.js';
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
	Document: ConfigExtensionSettingsAuthored;
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

function hasOwn(target: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(target, key);
}

// Untrusted names must neither read inherited entries nor change a map's prototype through `__proto__`.
function ownGet<T>(map: Record<string, T>, key: string): T | undefined {
	return hasOwn(map, key) ? map[key] : undefined;
}

function ownSet<T>(map: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

function isLeafMap(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DOCUMENT_FIELDS = new Set(['subject', 'global', 'collections']);

// Portable validation, directory parsing, and preservation share one field allowlist so a misspelled or reserved
// own field name is refused at every boundary rather than dropped and turned into a planned deletion.
function unknownDocumentField(record: object): string | undefined {
	return Object.keys(record).find((field) => !DOCUMENT_FIELDS.has(field));
}

// Joi skips an own `__proto__` key even in strict objects, so marker shape needs an own-key check.
function isExactPreserveMarker(value: Record<string, unknown>): boolean {
	const keys = Reflect.ownKeys(value);
	return keys.length === 1 && keys[0] === '$secret' && value['$secret'] === 'preserve';
}

function isPortableLeaf(value: unknown): boolean {
	if (isLeafMap(value)) return isExactPreserveMarker(value);
	return EXTENSION_SETTING_LEAF_SCHEMA.validate(value).error === undefined;
}

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

	for (const [key, value] of Object.entries(map)) ownSet(out, key, interpolateLeaf(value, subject, key));

	return out;
}

function leafMapOf(value: unknown): Record<string, unknown> {
	return isLeafMap(value) ? value : {};
}

function restoreCommittedPlaceholders(
	pending: ConfigExtensionSettings,
	existing: Record<string, unknown>
): ConfigExtensionSettings {
	const restoreMap = (
		target: Record<string, ExtensionSettingLeaf>,
		source: Record<string, unknown>
	): Record<string, ExtensionSettingLeaf> => {
		const out: Record<string, ExtensionSettingLeaf> = {};

		for (const [key, emitted] of Object.entries(target)) {
			const committed = ownGet(source, key);

			// A committed placeholder must not change the emitted value's type or secret category.
			if (isConfigPlaceholder(committed) && typeof emitted === 'string' && !isExtReference(emitted)) {
				ownSet(out, key, committed as ExtensionSettingLeaf);
			} else {
				ownSet(out, key, emitted);
			}
		}

		return out;
	};

	const existingCollections = leafMapOf(ownGet(existing, 'collections') ?? {});
	const collections: Record<string, Record<string, ExtensionSettingLeaf>> = {};

	for (const [collection, entries] of Object.entries(pending.collections)) {
		ownSet(collections, collection, restoreMap(entries, leafMapOf(ownGet(existingCollections, collection) ?? {})));
	}

	return {
		subject: pending.subject,
		global: restoreMap(pending.global, leafMapOf(ownGet(existing, 'global') ?? {})),
		collections,
	};
}

function preservationFailure(label: string, detail: string): ConfigReadFailedException {
	return new ConfigReadFailedException(
		`Config could not be written: the existing extension-settings file "${safeLogFragment(
			label
		)}" ${detail}, so its placeholder declarations cannot be preserved. Fix or remove it and retry.`
	);
}

function assertPortableLeafMap(value: unknown, label: string, where: string): void {
	if (!isLeafMap(value)) throw preservationFailure(label, `has a non-map ${where}`);

	for (const [key, leaf] of Object.entries(value)) {
		if (!ExtensionSettingKeySchema.safeParse(key).success) {
			throw preservationFailure(label, `declares an invalid setting key "${safeLogFragment(key)}" under ${where}`);
		}

		if (!isPortableLeaf(leaf)) {
			throw preservationFailure(label, `declares a non-portable value for "${safeLogFragment(key)}" under ${where}`);
		}
	}
}

// Preservation must work with unset variables and without a local declaration catalogue.
function assertPreservationStructure(existing: Record<string, unknown>, label: string): void {
	const unknownField = unknownDocumentField(existing);

	if (unknownField !== undefined) {
		throw preservationFailure(label, `has an unknown field "${safeLogFragment(unknownField)}"`);
	}

	const global = ownGet(existing, 'global');
	if (global !== undefined) assertPortableLeafMap(global, label, 'global');

	const collections = ownGet(existing, 'collections');

	if (collections !== undefined) {
		if (!isLeafMap(collections)) throw preservationFailure(label, 'has a non-map "collections"');

		for (const [collection, entries] of Object.entries(collections)) {
			assertPortableLeafMap(entries, label, `collection "${safeLogFragment(collection)}"`);
		}
	}
}

// EXT references are portable values, not unresolved CLI placeholders.
function residualConfigPlaceholders(documents: ConfigExtensionSettingsAuthored[]): string[] {
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

function scopeProblemDetail(problem: SettingScopeProblem, storedScope: string, storedScopeKey: string): string {
	switch (problem) {
		case 'scope':
			return `is stored at an unsupported scope "${safeLogFragment(storedScope)}"`;
		case 'global-key':
			return `is stored as a global value with a non-empty scope key "${safeLogFragment(storedScopeKey)}"`;
		case 'collection-key':
			return `is stored as a collection value whose scope key "${safeLogFragment(
				storedScopeKey
			)}" has no existing target collection`;
	}
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
		const collections = context.schema.collections ?? {};

		for (const row of rows) {
			const subject = row['extension'] as string;
			const declaration = snapshot.eligible.get(subject);
			// Out-of-scope subjects and undeclared keys stay inert, even if their stored values are malformed.
			if (declaration === undefined || (scope !== undefined && !scope.has(subject))) continue;

			const key = row['key'] as string;
			const declared = ownGet(declaration, key);
			if (declared === undefined) continue;

			const storedScope = row['scope'] as string;
			const storedScopeKey = row['scope_key'] as string;

			if (storedScope !== declared.scope) {
				throw unreadable(
					`extension setting ${safeLogFragment(subject)}/${safeLogFragment(key)}`,
					`is stored at scope "${safeLogFragment(storedScope)}" with scope key "${safeLogFragment(
						storedScopeKey
					)}" but declared at "${declared.scope}"`
				);
			}

			if (declared.secret !== undefined && declared.secret.source === 'config') continue;

			const scopeProblem = checkSettingScope(storedScope, storedScopeKey, (name) => hasOwn(collections, name));

			if (scopeProblem !== undefined) {
				throw unreadable(
					`extension setting ${safeLogFragment(subject)}/${safeLogFragment(key)}`,
					scopeProblemDetail(scopeProblem, storedScope, storedScopeKey)
				);
			}

			const storedValue = row['value'] as string;
			let parsed: unknown;

			try {
				parsed = JSON.parse(storedValue);
			} catch {
				throw unreadable(
					`extension setting ${safeLogFragment(subject)}/${safeLogFragment(key)}`,
					'did not read as valid JSON'
				);
			}

			const identity: ExtensionSettingsIdentity = {
				subject,
				scope: storedScope === COLLECTION_SCOPE ? COLLECTION_SCOPE : GLOBAL_SCOPE,
				scope_key: storedScopeKey,
				key,
			};

			if (declared.secret !== undefined) {
				if (!isSecretEnvelope(parsed)) {
					throw unreadable(
						`extension setting ${safeLogFragment(subject)}/${safeLogFragment(key)}`,
						'is declared secret but its stored value is not an encrypted envelope'
					);
				}

				records.push({ ...identity, value: PRESERVE_MARKER, fingerprint: fingerprintOf(storedValue) });
				continue;
			}

			if (typeof parsed !== declared.type) {
				throw unreadable(
					`extension setting ${safeLogFragment(subject)}/${safeLogFragment(key)}`,
					`holds a value that does not match the declared type "${declared.type}"`
				);
			}

			if (isExtReference(parsed)) {
				throw unreadable(
					`extension setting ${safeLogFragment(subject)}/${safeLogFragment(key)}`,
					'is an ordinary value that is a reserved runtime-reference expression'
				);
			}

			records.push({ ...identity, value: parsed as ExtensionSettingLeaf });
		}
	}

	// Runtime references come from declarations, not stored rows.
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

// Joi's object pattern skips an own `__proto__` key, so validate nested structure over the original document's own keys.
function validatePortableStructure(
	failures: ConfigFailure[],
	subjectLabel: string,
	document: ConfigExtensionSettingsAuthored
): void {
	const unknownField = unknownDocumentField(document);

	if (unknownField !== undefined) {
		failures.push(
			invalid(`Extension settings for "${subjectLabel}" have an unknown field "${safeLogFragment(unknownField)}".`)
		);
	}

	const checkLeafMap = (value: unknown, where: string): void => {
		if (!isLeafMap(value)) {
			failures.push(invalid(`Extension settings for "${subjectLabel}" have a non-map ${where}.`));
			return;
		}

		for (const [key, leaf] of Object.entries(value)) {
			if (!ExtensionSettingKeySchema.safeParse(key).success) {
				failures.push(
					invalid(`Extension setting "${subjectLabel}/${safeLogFragment(key)}" is not a valid setting key.`)
				);
			} else if (!isPortableLeaf(leaf)) {
				failures.push(
					invalid(
						`Extension setting "${subjectLabel}/${safeLogFragment(
							key
						)}" has a value that is not a portable setting value.`
					)
				);
			}
		}
	};

	if (document.global !== undefined) checkLeafMap(document.global, 'global map');

	const collections = document.collections;

	if (collections !== undefined) {
		if (!isLeafMap(collections)) {
			failures.push(invalid(`Extension settings for "${subjectLabel}" have a non-map collections field.`));
			return;
		}

		for (const [collection, entries] of Object.entries(collections)) {
			checkLeafMap(entries, `collection "${safeLogFragment(collection)}"`);
		}
	}
}

function validateDesired(
	documents: ConfigExtensionSettingsAuthored[],
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

		const structuralStart = failures.length;
		validatePortableStructure(failures, subjectLabel, document);
		if (failures.length > structuralStart) continue;

		if (context.references === 'server-snapshot') continue;

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

		const declared = ownGet(declaration, key);

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
		const declaration = declarations?.eligible.get(identity.subject);
		const declared = declaration !== undefined ? ownGet(declaration, identity.key) : undefined;
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
	const declaration = context.extensionDeclarations?.eligible.get(identity.subject);
	const declared = declaration !== undefined ? ownGet(declaration, identity.key) : undefined;

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

export const extensionSettingsDescriptor: Omit<
	ConfigResourceDescriptor<ExtensionSettingsKindTypes>,
	'composeDocuments' | 'restorePlaceholders' | 'layout'
> & {
	composeDocuments(records: ExtensionSettingRecord[], anchors: { subject: string }[]): ConfigExtensionSettings[];
	restorePlaceholders(pending: ConfigExtensionSettings, existing: Record<string, unknown>): ConfigExtensionSettings;
	layout: Omit<ConfigResourceDescriptor<ExtensionSettingsKindTypes>['layout'], 'parseDocumentFile'> & {
		parseDocumentFile(record: Record<string, unknown>, filename: string): ConfigExtensionSettings;
	};
} = {
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

			const unknown = unknownDocumentField(record);

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

				ownSet(collections, collection, interpolateLeafMap(entries, subject));
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
	projectDocuments: (documents: ConfigExtensionSettingsAuthored[]) => {
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
				const collection = ownGet(doc.collections, record.scope_key) ?? {};
				ownSet(doc.collections, record.scope_key, collection);
				ownSet(collection, record.key, record.value);
			} else {
				ownSet(doc.global, record.key, record.value);
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
	validatePreservationSource: assertPreservationStructure,
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
