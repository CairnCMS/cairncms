import { isAvailableLanguage } from '@cairncms/constants';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import type { TranslationsService } from '../../../services/translations.js';
import type {
	ConfigFailure,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigTranslations,
	ConfigTranslationsAuthored,
	TranslationsFieldChanges,
	TranslationsIdentity,
	TranslationsValues,
} from '../../../types/config.js';
import { CONFIG_FILENAME_STEM_MAX_LENGTH } from '../../config-contract.js';
import { safeLogFragment } from '../../safe-log-fragment.js';
import { compareCodeUnits } from '../canonical-encode.js';
import type {
	ApplyContext,
	ConfigFieldDescriptor,
	ConfigReadMode,
	ConfigResourceDescriptor,
	FieldSensitivity,
	KindPlan,
	NoConfigDependencies,
	ReadContext,
	ReadCurrentResult,
	ReadStateProjection,
	ValidationContext,
} from '../descriptor.js';
import { identityConflict, invalid } from '../failures.js';
import { UNFILTERED, unreadable } from '../read-parsing.js';
import { changesToValues, composeValues } from '../values.js';

const NON_SECRET: FieldSensitivity = { secret: false, redact: 'none' };

const TABLE = 'directus_translations';
const YAML_SUFFIX = '.yaml';

// Match the language and key column lengths in directus_translations.
const LANGUAGE_MAX_LENGTH = 255;
const KEY_MAX_LENGTH = 255;

type TranslationRecord = TranslationsIdentity & { value: string };

export interface TranslationsKindTypes {
	Kind: 'translations';
	Document: ConfigTranslationsAuthored;
	Record: TranslationRecord;
	Values: TranslationsValues;
	Identity: TranslationsIdentity;
	DocumentIdentity: { language: string };
	Create: { identity: TranslationsIdentity; value: string };
	Update: { identity: TranslationsIdentity; changes: TranslationsFieldChanges };
	Delete: { identity: TranslationsIdentity };
	Changes: TranslationsFieldChanges;
	ReadDependencyState: undefined;
	ApplyDependencyState: undefined;
	ReadDependencies: NoConfigDependencies;
	PlanDependencies: NoConfigDependencies;
	ApplyDependencies: NoConfigDependencies;
	Enrichment: Record<never, never>;
	ResultSlice: { created: number; updated: number; deleted: number };
	Outcome: { op: 'create'; count: number } | { op: 'update'; count: number } | { op: 'delete'; count: number };
}

const LANGUAGE_FIELD: ConfigFieldDescriptor = {
	name: 'language',
	type: 'string',
	required: true,
	nullable: false,
	minLength: 1,
	maxLength: LANGUAGE_MAX_LENGTH,
	acceptsPlaceholder: false,
	sensitivity: NON_SECRET,
	snapshotSafe: true,
	mutable: false,
	omissionPreservesCurrent: false,
};

// The diff uses this descriptor, while keyedMap validates the file's leaf values.
const VALUE_FIELD: ConfigFieldDescriptor = {
	name: 'value',
	type: 'string',
	required: true,
	nullable: false,
	allowEmpty: true,
	acceptsPlaceholder: false,
	sensitivity: NON_SECRET,
	snapshotSafe: true,
	mutable: true,
	omissionPreservesCurrent: false,
};

const RECORD_FIELDS: ConfigFieldDescriptor[] = [VALUE_FIELD];
const VALUE_FIELD_ORDER = ['value'] as const;

// Define __proto__ as an own data property, not a prototype setter.
function ownSet(map: Record<string, string>, key: string, value: string): void {
	Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

function isStringMap(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DOCUMENT_FIELDS = new Set(['language', 'translations']);

// Dropping an unknown field could turn a misspelled map into deletions.
function unknownDocumentField(record: object): string | undefined {
	return Object.keys(record).find((field) => !DOCUMENT_FIELDS.has(field));
}

const LOCALE_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Ownership is independent of supported-language validation.
function ownsFilenameStem(stem: string): boolean {
	return stem.length > 0 && stem.length <= CONFIG_FILENAME_STEM_MAX_LENGTH && LOCALE_STEM.test(stem);
}

function identityKeyOf(identity: TranslationsIdentity): string {
	return JSON.stringify([identity.language, identity.key]);
}

function compareIdentity(a: TranslationsIdentity, b: TranslationsIdentity): number {
	return compareCodeUnits(a.language, b.language) || compareCodeUnits(a.key, b.key);
}

async function readCurrent(
	context: ReadContext<TranslationsKindTypes>
): Promise<ReadCurrentResult<TranslationsKindTypes>> {
	const { TranslationsService } = await import('../../../services/translations.js');
	const service = new TranslationsService({ knex: context.database, schema: context.schema });
	const full = context.readMode === 'full';

	const rows = await service.readByQuery(
		{ limit: -1, fields: full ? ['language', 'key', 'value'] : ['language', 'key'] },
		UNFILTERED
	);

	const records: TranslationRecord[] = [];

	for (const row of rows) {
		const language = row['language'];
		const key = row['key'];

		if (typeof language !== 'string' || language === '') {
			throw unreadable('a translation row', 'column "language" is not a non-empty string');
		}

		if (typeof key !== 'string') {
			throw unreadable(`translation language=${safeLogFragment(language)}`, 'column "key" is not a string');
		}

		if (key.length > KEY_MAX_LENGTH) {
			throw unreadable(
				`translation language=${safeLogFragment(language)}`,
				`column "key" exceeds ${KEY_MAX_LENGTH} characters`
			);
		}

		if (!isAvailableLanguage(language)) {
			throw unreadable(`translation language=${safeLogFragment(language)}`, 'names a language that is not supported');
		}

		let value = '';

		if (full) {
			const stored = row['value'];

			if (typeof stored !== 'string') {
				throw unreadable(
					`translation ${safeLogFragment(language)}/${safeLogFragment(key)}`,
					'column "value" is not a string'
				);
			}

			value = stored;
		}

		records.push({ language, key, value });
	}

	records.sort(compareIdentity);

	const languages = [...new Set(records.map((record) => record.language))].sort(compareCodeUnits);

	return {
		records,
		documentIdentities: languages.map((language) => ({ language })),
		dependencyState: undefined,
	};
}

function projectReadState(result: ReadCurrentResult<TranslationsKindTypes>, mode: ConfigReadMode): ReadStateProjection {
	const identities = result.records.map((record) => identityKeyOf(record)).sort(compareCodeUnits);

	if (mode === 'identity') return { mode, identities };

	const values = result.records
		.map((record): [string, unknown] => [identityKeyOf(record), { value: record.value }])
		.sort((a, b) => compareCodeUnits(a[0], b[0]));

	return { mode, identities, values };
}

// Joi's object pattern skips an own `__proto__` key, so validate the map over the document's own keys.
function validatePortableStructure(
	failures: ConfigFailure[],
	languageLabel: string,
	document: ConfigTranslationsAuthored
): void {
	const unknownField = unknownDocumentField(document);

	if (unknownField !== undefined) {
		failures.push(
			invalid(`Translations for "${languageLabel}" have an unknown field "${safeLogFragment(unknownField)}".`)
		);
	}

	const translations = document.translations;
	if (translations === undefined) return;

	if (!isStringMap(translations)) {
		failures.push(invalid(`Translations for "${languageLabel}" have a non-map translations field.`));
		return;
	}

	for (const [key, value] of Object.entries(translations)) {
		if (key.length > KEY_MAX_LENGTH) {
			failures.push(
				invalid(
					`Translation key "${safeLogFragment(key)}" for "${languageLabel}" exceeds ${KEY_MAX_LENGTH} characters.`
				)
			);
		}

		if (typeof value !== 'string') {
			failures.push(invalid(`Translation "${languageLabel}/${safeLogFragment(key)}" must be a string value.`));
		}
	}
}

function validateDesired(
	documents: ConfigTranslationsAuthored[],
	_records: TranslationRecord[],
	_context: ValidationContext
): ConfigFailure[] {
	const failures: ConfigFailure[] = [];
	const seen = new Set<string>();

	for (const document of documents) {
		const language = document.language;
		const languageLabel = safeLogFragment(language);

		if (seen.has(language)) {
			failures.push(identityConflict(`Duplicate translations for language "${languageLabel}".`));
		}

		seen.add(language);

		const structuralStart = failures.length;
		validatePortableStructure(failures, languageLabel, document);
		if (failures.length > structuralStart) continue;

		// The shared catalogue also applies to portable snapshots.
		if (!isAvailableLanguage(language)) {
			failures.push(invalid(`Translations language "${languageLabel}" is not a supported language.`));
		}
	}

	return failures;
}

async function enrich(): Promise<TranslationsKindTypes['Enrichment']> {
	return {};
}

function emptyEnrichment(): TranslationsKindTypes['Enrichment'] {
	return {};
}

function toChanges(plan: KindPlan<TranslationsKindTypes>, _enrichment: ConfigPlanEnrichment): ConfigPlanChange[] {
	const changes: ConfigPlanChange[] = [];

	for (const create of plan.create) {
		changes.push({
			kind: 'translations',
			operation: 'create',
			identity: create.identity,
			values: { value: create.value },
		});
	}

	for (const update of plan.update) {
		changes.push({ kind: 'translations', operation: 'update', identity: update.identity, fields: update.changes });
	}

	for (const del of plan.delete) {
		changes.push({ kind: 'translations', operation: 'delete', identity: del.identity, impact: [] });
	}

	return changes;
}

async function serviceFor(context: ApplyContext<TranslationsKindTypes>): Promise<TranslationsService> {
	const { TranslationsService } = await import('../../../services/translations.js');

	return new TranslationsService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});
}

async function currentIdByIdentity(context: ApplyContext<TranslationsKindTypes>): Promise<Map<string, string>> {
	const rows = await context.database(TABLE).select('id', 'language', 'key');
	const map = new Map<string, string>();

	for (const row of rows) {
		map.set(identityKeyOf({ language: row['language'], key: row['key'] }), String(row['id']));
	}

	return map;
}

function idOrThrow(map: Map<string, string>, identity: TranslationsIdentity): string {
	const id = map.get(identityKeyOf(identity));

	if (id === undefined) {
		throw new ConfigInvalidException(
			`Translation "${safeLogFragment(identity.language)}/${safeLogFragment(identity.key)}" was not found during apply.`
		);
	}

	return id;
}

async function applyCreates(
	creates: TranslationsKindTypes['Create'][],
	context: ApplyContext<TranslationsKindTypes>
): Promise<Extract<TranslationsKindTypes['Outcome'], { op: 'create' }>> {
	const service = await serviceFor(context);
	let count = 0;

	for (const { identity, value } of creates) {
		await service.createOne({ language: identity.language, key: identity.key, value }, context.mutationOptions);
		count++;
	}

	return { op: 'create', count };
}

async function applyUpdates(
	updates: TranslationsKindTypes['Update'][],
	context: ApplyContext<TranslationsKindTypes>
): Promise<Extract<TranslationsKindTypes['Outcome'], { op: 'update' }>> {
	const service = await serviceFor(context);
	const idByIdentity = await currentIdByIdentity(context);
	let count = 0;

	for (const { identity, changes } of updates) {
		const value = changesToValues(changes)['value'] as string;
		await service.updateOne(idOrThrow(idByIdentity, identity), { value }, context.mutationOptions);
		count++;
	}

	return { op: 'update', count };
}

async function applyDeletes(
	deletes: TranslationsKindTypes['Delete'][],
	context: ApplyContext<TranslationsKindTypes>
): Promise<Extract<TranslationsKindTypes['Outcome'], { op: 'delete' }>> {
	const service = await serviceFor(context);
	const idByIdentity = await currentIdByIdentity(context);
	let count = 0;

	for (const { identity } of deletes) {
		const id = idByIdentity.get(identityKeyOf(identity));
		if (id === undefined) continue;

		await service.deleteOne(id, context.mutationOptions);
		count++;
	}

	return { op: 'delete', count };
}

async function readApplyDependencyState(): Promise<TranslationsKindTypes['ApplyDependencyState']> {
	return undefined;
}

function emptyResult(): TranslationsKindTypes['ResultSlice'] {
	return { created: 0, updated: 0, deleted: 0 };
}

function mergeOutcome(
	slice: TranslationsKindTypes['ResultSlice'],
	outcome: TranslationsKindTypes['Outcome']
): TranslationsKindTypes['ResultSlice'] {
	switch (outcome.op) {
		case 'create':
			return { ...slice, created: slice.created + outcome.count };
		case 'update':
			return { ...slice, updated: slice.updated + outcome.count };
		case 'delete':
			return { ...slice, deleted: slice.deleted + outcome.count };
	}
}

function composeDocument(language: string, records: TranslationRecord[]): ConfigTranslations {
	const translations: Record<string, string> = {};
	for (const record of records) ownSet(translations, record.key, record.value);
	return { language, translations };
}

export const translationsDescriptor: Omit<
	ConfigResourceDescriptor<TranslationsKindTypes>,
	'composeDocuments' | 'layout'
> & {
	composeDocuments(records: TranslationRecord[], anchors: { language: string }[]): ConfigTranslations[];
	layout: Omit<ConfigResourceDescriptor<TranslationsKindTypes>['layout'], 'parseDocumentFile'> & {
		parseDocumentFile(record: Record<string, unknown>, filename: string): ConfigTranslations;
	};
} = {
	kind: 'translations' as const,
	formatVersion: 2,
	dependencies: [] as [],
	layout: {
		directory: 'translations',
		documentShape: { keyedMap: { field: 'translations' } },
		documentIdentityOf: (document: ConfigTranslations) => ({ language: document.language }),
		filenameOf: (documentIdentity: { language: string }) => documentIdentity.language,
		ownsFilenameStem,
		parseDocumentFile: (record: Record<string, unknown>, filename: string): ConfigTranslations => {
			const language = record['language'];

			if (typeof language !== 'string' || language === '') {
				throw new ConfigInvalidException(`Translations file "${safeLogFragment(filename)}" is missing a "language".`);
			}

			const unknown = unknownDocumentField(record);

			if (unknown !== undefined) {
				throw new ConfigInvalidException(
					`Translations file "${safeLogFragment(filename)}" has an unknown field "${safeLogFragment(unknown)}".`
				);
			}

			if (record['translations'] !== undefined && !isStringMap(record['translations'])) {
				throw new ConfigInvalidException(
					`Translations file "${safeLogFragment(filename)}" has a non-map "translations".`
				);
			}

			const expected = `${language}${YAML_SUFFIX}`;

			if (filename !== expected) {
				throw new ConfigInvalidException(
					`Translations file "${safeLogFragment(filename)}" holds language "${safeLogFragment(
						language
					)}"; filename must be "${safeLogFragment(expected)}".`
				);
			}

			const map = (record['translations'] as Record<string, unknown>) ?? {};
			const translations: Record<string, string> = {};

			for (const [key, value] of Object.entries(map)) {
				if (typeof value !== 'string') {
					throw new ConfigInvalidException(
						`Translations file "${safeLogFragment(filename)}" has a non-string value for "${safeLogFragment(key)}".`
					);
				}

				ownSet(translations, key, value);
			}

			return { language, translations };
		},
	},
	documentIdentityFields: [LANGUAGE_FIELD],
	recordFields: RECORD_FIELDS,
	valueFieldOrder: VALUE_FIELD_ORDER,
	emittedDocumentSubject: (identity: { language: string }) => ({
		label: 'translations language',
		value: identity.language,
	}),
	projectDocuments: (documents: ConfigTranslationsAuthored[]) => {
		const records: TranslationRecord[] = [];

		for (const document of documents) {
			for (const [key, value] of Object.entries(document.translations ?? {})) {
				records.push({ language: document.language, key, value: value as string });
			}
		}

		return { records, anchors: documents.map((document) => ({ language: document.language })) };
	},
	composeDocuments: (records: TranslationRecord[], anchors: { language: string }[]): ConfigTranslations[] => {
		const byLanguage = new Map<string, TranslationRecord[]>();

		for (const anchor of anchors) byLanguage.set(anchor.language, []);

		for (const record of records) {
			const bucket = byLanguage.get(record.language) ?? [];
			bucket.push(record);
			byLanguage.set(record.language, bucket);
		}

		return anchors.map((anchor) => composeDocument(anchor.language, byLanguage.get(anchor.language) ?? []));
	},
	identityOf: (record: TranslationRecord): TranslationsIdentity => ({ language: record.language, key: record.key }),
	identityKey: identityKeyOf,
	compareIdentity,
	identityOfDelete: (entry: { identity: TranslationsIdentity }) => entry.identity,
	canonicalizeValues: (record: TranslationRecord) =>
		composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>) as TranslationsValues,
	toCreateEntry: (record: TranslationRecord) => ({
		identity: { language: record.language, key: record.key },
		value: record.value,
	}),
	toUpdateEntry: (identity: TranslationsIdentity, changes: TranslationsFieldChanges) => ({ identity, changes }),
	toDeleteEntry: (identity: TranslationsIdentity) => ({ identity }),
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
