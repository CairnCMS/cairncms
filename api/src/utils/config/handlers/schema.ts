import { normalizeConfigKey, toArray } from '@cairncms/utils';
import Joi from 'joi';
import { isEqual, isPlainObject } from 'lodash-es';
import { createHash } from 'node:crypto';
import { isInternalTable } from '../../../database/internal-tables.js';
import env from '../../../env.js';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import { InvalidPayloadException } from '../../../exceptions/invalid-payload.js';
import type {
	ConfigFailure,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigSchemaCollection,
	SchemaChangeEntry,
	SchemaFieldChanges,
	SchemaIdentity,
	SchemaValues,
} from '../../../types/config.js';
import type {
	Collection,
	PortableSnapshot,
	Snapshot,
	SnapshotDiff,
	SnapshotField,
	SnapshotRelation,
} from '../../../types/index.js';
import { CONFIG_FILENAME_STEM_MAX_LENGTH } from '../../config-contract.js';
import { alignToDesiredReferences, toKeyFormSnapshot } from '../../folder-references.js';
import { getPortableSnapshot } from '../../get-portable-snapshot.js';
import { getSnapshot } from '../../get-snapshot.js';
import { getSnapshotDiff } from '../../get-snapshot-diff.js';
import { getVersionedHash } from '../../get-versioned-hash.js';
import { version as currentRelease } from '../../package.js';
import { reconcileDesiredSchema } from '../../reconcile-desired-schema.js';
import { replaceControlCharacters, safeLogFragment } from '../../safe-log-fragment.js';
import { sanitizeCollection, sanitizeField, sanitizeRelation } from '../../sanitize-schema.js';
import { collectionEntitySchema, fieldEntitySchema, relationEntitySchema } from '../../snapshot-entity-schemas.js';
import { isUnconfiguredTableDrop } from '../../unconfigured-table-drop.js';
import { compareCodeUnits } from '../canonical-encode.js';
import { identityConflict, invalid } from '../failures.js';
import type {
	ConfigFieldDescriptor,
	ConfigReadMode,
	ConfigResourceDescriptor,
	FieldSensitivity,
	KindPlan,
	NoConfigDependencies,
	ReadContext,
	ReadCurrentResult,
	ReadStateProjection,
} from '../descriptor.js';
import { composeValues } from '../values.js';

const NON_SECRET: FieldSensitivity = { secret: false, redact: 'none' };

export interface SchemaKindTypes {
	Kind: 'schema';
	Document: ConfigSchemaCollection;
	Record: ConfigSchemaCollection;
	Values: SchemaValues;
	Identity: SchemaIdentity;
	DocumentIdentity: SchemaIdentity;
	Create: SchemaChangeEntry;
	Update: SchemaChangeEntry;
	Delete: SchemaChangeEntry;
	Changes: SchemaFieldChanges;
	ReadDependencyState: { storedFields: SnapshotField[]; keyFormHash: string };
	ApplyDependencyState: undefined;
	ReadDependencies: NoConfigDependencies;
	PlanDependencies: NoConfigDependencies;
	ApplyDependencies: NoConfigDependencies;
	Enrichment: Record<never, never>;
	ResultSlice: { created: number; updated: number; deleted: number };
	Outcome: { op: 'create'; count: number } | { op: 'update'; count: number } | { op: 'delete'; count: number };
}

function unsupported(operation: string): never {
	throw new Error(`Schema ${operation} is not supported.`);
}

// Database vendors impose different identifier limits; filenames are bounded separately.
const COLLECTION_FIELD: ConfigFieldDescriptor = {
	name: 'collection',
	type: 'string',
	required: true,
	nullable: false,
	minLength: 1,
	acceptsPlaceholder: false,
	sensitivity: NON_SECRET,
	snapshotSafe: true,
	mutable: false,
	omissionPreservesCurrent: false,
};

const STEM_HASH_LENGTH = 8;
const STEM_SLUG_MAX_LENGTH = CONFIG_FILENAME_STEM_MAX_LENGTH - STEM_HASH_LENGTH - 1;

const DERIVED_STEM = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;

// Windows device names remain reserved even with the .yaml extension.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isNormalizedStem(stem: string): boolean {
	return (
		stem.length > 0 &&
		stem.length <= CONFIG_FILENAME_STEM_MAX_LENGTH &&
		normalizeConfigKey(stem) === stem &&
		!WINDOWS_RESERVED.test(stem)
	);
}

function derivedStemFor(collection: string): string {
	const slug = collection
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase()
		.slice(0, STEM_SLUG_MAX_LENGTH)
		.replace(/-+$/g, '');

	const hash = createHash('sha256').update(collection).digest('hex').slice(0, STEM_HASH_LENGTH);

	// An empty slug must not collide with a collection whose name is the bare hash.
	return slug === '' ? `collection-${hash}` : `${slug}-${hash}`;
}

function filenameStemFor(collection: string): string {
	return isNormalizedStem(collection) ? collection : derivedStemFor(collection);
}

function ownsFilenameStem(stem: string): boolean {
	if (stem.length > CONFIG_FILENAME_STEM_MAX_LENGTH) return false;
	return isNormalizedStem(stem) || DERIVED_STEM.test(stem);
}

const DOCUMENT_FIELDS = new Set(['collection', 'meta', 'schema', 'fields', 'relations']);

function isMapping(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value);
}

function parseSchemaDocumentFile(record: Record<string, unknown>, filename: string): ConfigSchemaCollection {
	const label = safeLogFragment(filename);
	const collection = record['collection'];

	if (typeof collection !== 'string' || collection === '') {
		throw new ConfigInvalidException(`Schema file "${label}" is missing a "collection".`);
	}

	const unknownField = Object.keys(record).find((key) => !DOCUMENT_FIELDS.has(key));

	if (unknownField !== undefined) {
		throw new ConfigInvalidException(`Schema file "${label}" has an unknown field "${safeLogFragment(unknownField)}".`);
	}

	const fields = record['fields'];
	const relations = record['relations'];

	if (!Array.isArray(fields)) {
		throw new ConfigInvalidException(`Schema file "${label}" must declare "fields" as an array.`);
	}

	if (!Array.isArray(relations)) {
		throw new ConfigInvalidException(`Schema file "${label}" must declare "relations" as an array.`);
	}

	const document: ConfigSchemaCollection = {
		collection,
		fields: fields as ConfigSchemaCollection['fields'],
		relations: relations as ConfigSchemaCollection['relations'],
	};

	if (Object.hasOwn(record, 'meta')) {
		document.meta = record['meta'] as Exclude<ConfigSchemaCollection['meta'], undefined>;
	}

	if (Object.hasOwn(record, 'schema')) {
		document.schema = record['schema'] as Exclude<ConfigSchemaCollection['schema'], undefined>;
	}

	const [problem] = schemaRecordProblems(document);

	if (problem) {
		throw new ConfigInvalidException(`Schema file "${label}": ${problem.message}`);
	}

	return document;
}

function removesUnkeptFile(declared: unknown, filename: string): boolean {
	if (!isMapping(declared)) return false;

	try {
		parseSchemaDocumentFile(declared, filename);
		return true;
	} catch (error) {
		if (error instanceof ConfigInvalidException) return false;
		throw error;
	}
}

const RECORD_FIELDS: ConfigFieldDescriptor[] = [
	{
		name: 'fields',
		type: 'json-array',
		arrayItems: 'record',
		required: true,
		nullable: false,
		acceptsPlaceholder: false,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: false,
	},
	{
		name: 'relations',
		type: 'json-array',
		arrayItems: 'record',
		required: true,
		nullable: false,
		acceptsPlaceholder: false,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: false,
	},
	{
		name: 'meta',
		type: 'policy-object',
		required: false,
		nullable: true,
		acceptsPlaceholder: false,
		sensitivity: NON_SECRET,
		snapshotSafe: false,
		mutable: true,
		omissionPreservesCurrent: true,
	},
	{
		name: 'schema',
		type: 'policy-object',
		required: false,
		nullable: true,
		acceptsPlaceholder: false,
		sensitivity: NON_SECRET,
		snapshotSafe: false,
		mutable: true,
		omissionPreservesCurrent: true,
	},
];

const VALUE_FIELD_ORDER = ['meta', 'schema', 'fields', 'relations'] as const;

// These helpers also run for unmanaged kinds and must not enter the schema execution engine.
function emptyEnrichment(): SchemaKindTypes['Enrichment'] {
	return {};
}

function createValues(changes: SchemaFieldChanges): SchemaValues {
	const values: SchemaValues = {};

	for (const [key, change] of Object.entries(changes)) {
		values[key] = change.after;
	}

	return values;
}

function toChanges(plan: KindPlan<SchemaKindTypes>, _enrichment: ConfigPlanEnrichment): ConfigPlanChange[] {
	const changes: ConfigPlanChange[] = [];

	for (const entry of plan.create) {
		const values = createValues(entry.changes);

		switch (entry.changeKind) {
			case 'collections':
				changes.push({ kind: 'collections', operation: 'create', identity: entry.identity, values });
				break;
			case 'fields':
				changes.push({ kind: 'fields', operation: 'create', identity: entry.identity, values });
				break;
			case 'relations':
				changes.push({
					kind: 'relations',
					operation: 'create',
					identity: entry.identity,
					relatedCollection: entry.relatedCollection,
					values,
				});

				break;
		}
	}

	for (const entry of plan.update) {
		switch (entry.changeKind) {
			case 'collections':
				changes.push({ kind: 'collections', operation: 'update', identity: entry.identity, fields: entry.changes });
				break;
			case 'fields':
				changes.push({ kind: 'fields', operation: 'update', identity: entry.identity, fields: entry.changes });
				break;
			case 'relations':
				changes.push({
					kind: 'relations',
					operation: 'update',
					identity: entry.identity,
					relatedCollection: entry.relatedCollection,
					fields: entry.changes,
				});

				break;
		}
	}

	for (const entry of plan.delete) {
		switch (entry.changeKind) {
			case 'collections':
				changes.push({ kind: 'collections', operation: 'delete', identity: entry.identity, impact: [] });
				break;
			case 'fields':
				changes.push({ kind: 'fields', operation: 'delete', identity: entry.identity, impact: [] });
				break;
			case 'relations':
				changes.push({
					kind: 'relations',
					operation: 'delete',
					identity: entry.identity,
					relatedCollection: entry.relatedCollection,
					impact: [],
				});

				break;
		}
	}

	return changes;
}

function emptyResult(): SchemaKindTypes['ResultSlice'] {
	return { created: 0, updated: 0, deleted: 0 };
}

function mergeOutcome(
	slice: SchemaKindTypes['ResultSlice'],
	_outcome: SchemaKindTypes['Outcome']
): SchemaKindTypes['ResultSlice'] {
	return slice;
}

function relationInScope(relation: SnapshotRelation, excluded: ReadonlySet<string>): boolean {
	for (const endpoint of [relation.collection, relation.related_collection]) {
		if (typeof endpoint !== 'string') continue;
		if (isInternalTable(endpoint) || excluded.has(endpoint)) return false;
	}

	return true;
}

function groupSnapshotCollections(snapshot: PortableSnapshot): ConfigSchemaCollection[] {
	const excluded = new Set(toArray(env['DB_EXCLUDE_TABLES']));

	const fieldsByCollection = new Map<string, SnapshotField[]>();

	for (const field of snapshot.fields) {
		const group = fieldsByCollection.get(field.collection) ?? [];
		group.push(field);
		fieldsByCollection.set(field.collection, group);
	}

	const relationsByCollection = new Map<string, SnapshotRelation[]>();

	for (const relation of snapshot.relations) {
		if (!relationInScope(relation, excluded)) continue;

		const group = relationsByCollection.get(relation.collection) ?? [];
		group.push(relation);
		relationsByCollection.set(relation.collection, group);
	}

	const membersOf = (name: string) => ({
		fields: fieldsByCollection.get(name) ?? [],
		relations: relationsByCollection.get(name) ?? [],
	});

	const records: ConfigSchemaCollection[] = [];
	const emitted = new Set<string>();

	for (const collection of snapshot.collections) {
		const name = collection.collection;
		emitted.add(name);

		// System collection definitions belong to the platform, even when metadata overrides exist.
		if (name.startsWith('directus_')) {
			records.push({ collection: name, ...membersOf(name) });
			continue;
		}

		records.push({
			collection: name,
			meta: collection.meta,
			...(collection.schema !== undefined && { schema: collection.schema }),
			...membersOf(name),
		});
	}

	// Operator-added system fields and orphaned relations can have owners absent from snapshot.collections.
	for (const owner of [...fieldsByCollection.keys(), ...relationsByCollection.keys()]) {
		if (emitted.has(owner)) continue;
		emitted.add(owner);

		if (owner.startsWith('directus_')) {
			records.push({ collection: owner, ...membersOf(owner) });
		} else {
			records.push({ collection: owner, meta: null, ...membersOf(owner) });
		}
	}

	records.sort((a, b) => compareCodeUnits(a.collection, b.collection));

	return records;
}

async function readCurrent(context: ReadContext<SchemaKindTypes>): Promise<ReadCurrentResult<SchemaKindTypes>> {
	const snapshot = await getSnapshot({ database: context.database, schema: context.schema });
	const portable = await getPortableSnapshot(snapshot, { database: context.database });
	const records = groupSnapshotCollections(portable);
	const keyForm = await toKeyFormSnapshot(snapshot, { database: context.database });

	return {
		records,
		documentIdentities: records.map((record) => ({ collection: record.collection })),
		dependencyState: { storedFields: snapshot.fields, keyFormHash: getVersionedHash(keyForm.snapshot) },
	};
}

function projectReadState(result: ReadCurrentResult<SchemaKindTypes>, mode: ConfigReadMode): ReadStateProjection {
	const identities = result.records.map((record) => record.collection);

	if (mode === 'identity') {
		return { mode, identities };
	}

	const values = result.records.map((record): [string, unknown] => [
		record.collection,
		composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>),
	]);

	return { mode, identities, values };
}

const COLLECTION_VALUE_ATTRIBUTES = ['meta', 'schema'] as const;
const FIELD_VALUE_ATTRIBUTES = ['type', 'meta', 'schema'] as const;
const RELATION_VALUE_ATTRIBUTES = ['related_collection', 'meta', 'schema'] as const;

function entityKey(collection: string, field: string): string {
	return JSON.stringify([collection, field]);
}

function unfoldToSnapshot(records: ConfigSchemaCollection[]): {
	collections: Collection[];
	fields: SnapshotField[];
	relations: SnapshotRelation[];
} {
	const collections: Collection[] = [];
	const fields: SnapshotField[] = [];
	const relations: SnapshotRelation[] = [];

	for (const record of records) {
		if (Object.hasOwn(record, 'meta') || Object.hasOwn(record, 'schema')) {
			const collection: Record<string, unknown> = { collection: record.collection };
			if (Object.hasOwn(record, 'meta')) collection['meta'] = record.meta;
			if (Object.hasOwn(record, 'schema')) collection['schema'] = record.schema;
			collections.push(collection as unknown as Collection);
		}

		fields.push(...record.fields);
		relations.push(...record.relations);
	}

	return { collections, fields, relations };
}

function bucketOf(plan: KindPlan<SchemaKindTypes>, before: unknown, after: unknown): SchemaChangeEntry[] {
	if (before === undefined) return plan.create;
	if (after === undefined) return plan.delete;
	return plan.update;
}

function changedAttributes(
	diff: readonly unknown[] | undefined,
	before: unknown,
	after: unknown,
	valueAttributes: readonly string[]
): readonly string[] {
	if (before === undefined || after === undefined) return valueAttributes;

	const changed = new Set<string>();

	for (const entry of diff ?? []) {
		const path = (entry as { path?: readonly unknown[] }).path;

		if (path === undefined || path.length === 0) {
			for (const attribute of valueAttributes) changed.add(attribute);
			continue;
		}

		const top = path[0];
		if (typeof top === 'string' && valueAttributes.includes(top)) changed.add(top);
	}

	return [...changed];
}

function attributeChanges(before: unknown, after: unknown, attributes: readonly string[]): SchemaFieldChanges {
	const beforeObject = before as Record<string, unknown> | undefined;
	const afterObject = after as Record<string, unknown> | undefined;
	const changes: SchemaFieldChanges = {};

	for (const attribute of attributes) {
		const beforePresent = beforeObject !== undefined && Object.hasOwn(beforeObject, attribute);
		const afterPresent = afterObject !== undefined && Object.hasOwn(afterObject, attribute);
		const beforeValue = beforePresent ? beforeObject![attribute] : null;
		const afterValue = afterPresent ? afterObject![attribute] : null;

		if (beforePresent === afterPresent && isEqual(beforeValue, afterValue)) continue;

		changes[attribute] = {
			before: beforeValue,
			after: afterValue,
			...(beforePresent ? {} : { beforePresent: false }),
			...(afterPresent ? {} : { afterPresent: false }),
		};
	}

	return changes;
}

function translateSnapshotDiff(
	diff: SnapshotDiff,
	current: Snapshot,
	desired: Snapshot | PortableSnapshot
): KindPlan<SchemaKindTypes> {
	const plan: KindPlan<SchemaKindTypes> = { create: [], update: [], delete: [] };

	const currentCollections = new Map(current.collections.map((entry) => [entry.collection, entry]));
	const desiredCollections = new Map(desired.collections.map((entry) => [entry.collection, entry]));

	for (const { collection, diff: entryDiff } of diff.collections) {
		const before = currentCollections.get(collection);
		const after = desiredCollections.get(collection);
		const attributes = changedAttributes(entryDiff, before, after, COLLECTION_VALUE_ATTRIBUTES);

		bucketOf(plan, before, after).push({
			changeKind: 'collections',
			identity: { collection },
			changes: attributeChanges(sanitizeCollection(before), sanitizeCollection(after), attributes),
			...(after === undefined && isUnconfiguredTableDrop(before) ? { unconfiguredTableDrop: true as const } : {}),
		});
	}

	const currentFields = new Map(current.fields.map((entry) => [entityKey(entry.collection, entry.field), entry]));
	const desiredFields = new Map(desired.fields.map((entry) => [entityKey(entry.collection, entry.field), entry]));

	for (const { collection, field, diff: entryDiff } of diff.fields) {
		const before = currentFields.get(entityKey(collection, field));
		const after = desiredFields.get(entityKey(collection, field));
		const attributes = changedAttributes(entryDiff, before, after, FIELD_VALUE_ATTRIBUTES);

		const currentSchema = (
			before as { schema?: { is_primary_key?: boolean; has_auto_increment?: boolean } } | undefined
		)?.schema;

		const autoIncrementPrimaryKey =
			Boolean(currentSchema?.is_primary_key) && Boolean(currentSchema?.has_auto_increment);

		bucketOf(plan, before, after).push({
			changeKind: 'fields',
			identity: { collection, field },
			changes: attributeChanges(
				sanitizeField(before, autoIncrementPrimaryKey),
				sanitizeField(after, autoIncrementPrimaryKey),
				attributes
			),
		});
	}

	const currentRelations = new Map(current.relations.map((entry) => [entityKey(entry.collection, entry.field), entry]));
	const desiredRelations = new Map(desired.relations.map((entry) => [entityKey(entry.collection, entry.field), entry]));

	for (const { collection, field, diff: entryDiff } of diff.relations) {
		const before = currentRelations.get(entityKey(collection, field));
		const after = desiredRelations.get(entityKey(collection, field));
		const relatedCollection = (after ?? before)?.related_collection ?? null;
		const attributes = changedAttributes(entryDiff, before, after, RELATION_VALUE_ATTRIBUTES);

		bucketOf(plan, before, after).push({
			changeKind: 'relations',
			identity: { collection, field },
			relatedCollection,
			changes: attributeChanges(sanitizeRelation(before), sanitizeRelation(after), attributes),
		});
	}

	return plan;
}

export function reconcileDesiredSchemaSnapshot(
	currentRecords: ConfigSchemaCollection[],
	desiredRecords: ConfigSchemaCollection[]
): { current: Snapshot; desired: PortableSnapshot } {
	const current = unfoldToSnapshot(currentRecords);
	const desired = unfoldToSnapshot(desiredRecords);

	const currentKeyForm: Snapshot = {
		version: 1,
		directus: currentRelease,
		collections: current.collections,
		fields: current.fields,
		relations: current.relations,
	};

	let desiredSnapshot: PortableSnapshot;

	try {
		desiredSnapshot = reconcileDesiredSchema(currentKeyForm, {
			version: 2,
			release: currentRelease,
			collections: desired.collections,
			fields: desired.fields,
			relations: desired.relations,
		});
	} catch (error) {
		if (error instanceof InvalidPayloadException) {
			throw new ConfigInvalidException(replaceControlCharacters(error.message));
		}

		throw error;
	}

	return { current: currentKeyForm, desired: desiredSnapshot };
}

export function computeSchemaDiff(
	currentRecords: ConfigSchemaCollection[],
	desiredRecords: ConfigSchemaCollection[],
	storedFields: SnapshotField[] | undefined
): { diff: SnapshotDiff; currentSnapshot: Snapshot; desiredSnapshot: PortableSnapshot } {
	if (storedFields === undefined) {
		throw new Error('Schema planning requires the retained current schema fields.');
	}

	const { current: currentKeyForm, desired: desiredSnapshot } = reconcileDesiredSchemaSnapshot(
		currentRecords,
		desiredRecords
	);

	const currentSnapshot: Snapshot = {
		...currentKeyForm,
		fields: alignToDesiredReferences(currentKeyForm.fields, storedFields, desiredSnapshot.fields),
	};

	return { diff: getSnapshotDiff(currentSnapshot, desiredSnapshot), currentSnapshot, desiredSnapshot };
}

export function computeSchemaPlan(
	currentRecords: ConfigSchemaCollection[],
	desiredRecords: ConfigSchemaCollection[],
	storedFields: SnapshotField[] | undefined
): KindPlan<SchemaKindTypes> {
	const { diff, currentSnapshot, desiredSnapshot } = computeSchemaDiff(currentRecords, desiredRecords, storedFields);

	return translateSnapshotDiff(diff, currentSnapshot, desiredSnapshot);
}

function collectJoiFailures(failures: ConfigFailure[], result: Joi.ValidationResult, label: string): void {
	if (!result.error) return;

	for (const detail of result.error.details) {
		failures.push(invalid(`Schema ${label}: ${replaceControlCharacters(detail.message)}`));
	}
}

function structuralFailures(document: ConfigSchemaCollection): ConfigFailure[] {
	const failures: ConfigFailure[] = [];
	const label = safeLogFragment(document.collection);
	const options = { convert: false, abortEarly: false };

	const collectionEntity: Record<string, unknown> = { collection: document.collection };
	if (Object.hasOwn(document, 'meta')) collectionEntity['meta'] = document.meta;
	if (Object.hasOwn(document, 'schema')) collectionEntity['schema'] = document.schema;

	collectJoiFailures(failures, collectionEntitySchema.validate(collectionEntity, options), `collection "${label}"`);

	for (const field of document.fields) {
		collectJoiFailures(failures, fieldEntitySchema.validate(field, options), `field in "${label}"`);
	}

	for (const relation of document.relations) {
		collectJoiFailures(failures, relationEntitySchema.validate(relation, options), `relation in "${label}"`);
	}

	return failures;
}

function ownedElementProblems(
	elements: unknown[],
	kind: 'field' | 'relation',
	owner: string,
	label: string
): ConfigFailure[] {
	const problems: ConfigFailure[] = [];
	const seen = new Set<string>();

	for (const element of elements) {
		if (!isMapping(element)) {
			problems.push(invalid(`Schema collection "${label}" has a ${kind} that is not a mapping.`));
			continue;
		}

		const declared = element['collection'];

		if (typeof declared !== 'string') {
			problems.push(invalid(`Schema collection "${label}" has a ${kind} without a string "collection".`));
		} else if (declared !== owner) {
			problems.push(
				invalid(`Schema collection "${label}" has a ${kind} declaring collection "${safeLogFragment(declared)}".`)
			);
		}

		const name = element['field'];

		if (typeof name !== 'string' || name === '') {
			problems.push(invalid(`Schema collection "${label}" has a ${kind} without a string "field".`));
			continue;
		}

		if (seen.has(name)) {
			problems.push(
				identityConflict(`Schema collection "${label}" declares duplicate ${kind} "${safeLogFragment(name)}".`)
			);
		}

		seen.add(name);
	}

	return problems;
}

function schemaRecordProblems(document: ConfigSchemaCollection): ConfigFailure[] {
	const problems: ConfigFailure[] = [];
	const collection = document.collection;
	const label = safeLogFragment(collection);

	if (isInternalTable(collection)) {
		problems.push(invalid(`Schema collection "${label}" is an internal table, which is not operator-managed schema.`));
	}

	if (collection.startsWith('directus_') && (Object.hasOwn(document, 'meta') || Object.hasOwn(document, 'schema'))) {
		problems.push(invalid(`System collection "${label}" must declare only fields, not a collection definition.`));
	}

	if (!collection.startsWith('directus_') && !Object.hasOwn(document, 'meta')) {
		problems.push(invalid(`Schema collection "${label}" must declare "meta", which can be null.`));
	}

	problems.push(...ownedElementProblems(document.fields, 'field', collection, label));
	problems.push(...ownedElementProblems(document.relations, 'relation', collection, label));

	return problems;
}

function validateDesired(documents: ConfigSchemaCollection[]): ConfigFailure[] {
	const failures: ConfigFailure[] = [];
	const seen = new Set<string>();

	for (const document of documents) {
		if (seen.has(document.collection)) {
			failures.push(identityConflict(`Duplicate schema collection "${safeLogFragment(document.collection)}".`));
		}

		seen.add(document.collection);

		failures.push(...structuralFailures(document));
		failures.push(...schemaRecordProblems(document));
	}

	return failures;
}

export const schemaDescriptor: ConfigResourceDescriptor<SchemaKindTypes> = {
	kind: 'schema',
	formatVersion: 3,
	dependencies: [],
	layout: {
		directory: 'schema',
		documentShape: 'flat',
		documentIdentityOf: (document) => ({ collection: document.collection }),
		filenameOf: (documentIdentity) => filenameStemFor(documentIdentity.collection),
		ownsFilenameStem,
		parseDocumentFile: parseSchemaDocumentFile,
		removesUnkeptFile,
	},
	documentIdentityFields: [COLLECTION_FIELD],
	recordFields: RECORD_FIELDS,
	valueFieldOrder: VALUE_FIELD_ORDER,
	emittedDocumentSubject: (identity) => ({ label: 'collection', value: identity.collection }),
	projectDocuments: (documents) => ({
		records: documents,
		anchors: documents.map((document) => ({ collection: document.collection })),
	}),
	composeDocuments: (records) => records,
	identityOf: (record) => ({ collection: record.collection }),
	identityKey: (identity) => JSON.stringify([identity.collection]),
	compareIdentity: (a, b) => compareCodeUnits(a.collection, b.collection),
	identityOfDelete: (entry) => ({ collection: entry.identity.collection }),
	canonicalizeValues: () => unsupported('planning'),
	toCreateEntry: () => unsupported('planning'),
	toUpdateEntry: () => unsupported('planning'),
	toDeleteEntry: () => unsupported('planning'),
	handler: {
		readCurrent,
		projectReadState,
		validateDesired,
		postPlan: () => unsupported('planning'),
		enrich: async () => emptyEnrichment(),
		emptyEnrichment,
		toChanges,
		applyCreates: async () => unsupported('apply'),
		applyUpdates: async () => unsupported('apply'),
		applyDeletes: async () => unsupported('apply'),
		readApplyDependencyState: async () => undefined,
		emptyResult,
		mergeOutcome,
	},
};
