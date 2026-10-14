import { normalizeConfigKey, toArray } from '@cairncms/utils';
import { isPlainObject } from 'lodash-es';
import { createHash } from 'node:crypto';
import { isInternalTable } from '../../../database/internal-tables.js';
import env from '../../../env.js';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import type {
	ConfigPlanChange,
	ConfigPlanEnrichment,
	ConfigSchemaCollection,
	SchemaFieldChanges,
	SchemaIdentity,
	SchemaValues,
} from '../../../types/config.js';
import type { PortableSnapshot, SnapshotField, SnapshotRelation } from '../../../types/index.js';
import { CONFIG_FILENAME_STEM_MAX_LENGTH } from '../../config-contract.js';
import { getPortableSnapshot } from '../../get-portable-snapshot.js';
import { getSnapshot } from '../../get-snapshot.js';
import { safeLogFragment } from '../../safe-log-fragment.js';
import { compareCodeUnits } from '../canonical-encode.js';
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
	Create: ConfigSchemaCollection;
	Update: { collection: string; changes: SchemaFieldChanges };
	Delete: SchemaIdentity;
	Changes: SchemaFieldChanges;
	ReadDependencyState: undefined;
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

function assertOwnedElements(elements: unknown[], kind: string, collection: string, filename: string): void {
	const label = safeLogFragment(filename);

	elements.forEach((element, index) => {
		if (!isMapping(element)) {
			throw new ConfigInvalidException(`Schema file "${label}" has a ${kind} at index ${index} that is not a mapping.`);
		}

		const owner = element['collection'];

		if (typeof owner !== 'string') {
			throw new ConfigInvalidException(
				`Schema file "${label}" has a ${kind} at index ${index} without a string "collection".`
			);
		}

		if (owner !== collection) {
			throw new ConfigInvalidException(
				`Schema file "${label}" has a ${kind} declaring collection "${safeLogFragment(
					owner
				)}", but the file declares "${safeLogFragment(collection)}".`
			);
		}
	});
}

function parseSchemaDocumentFile(record: Record<string, unknown>, filename: string): ConfigSchemaCollection {
	const label = safeLogFragment(filename);
	const collection = record['collection'];

	if (typeof collection !== 'string' || collection === '') {
		throw new ConfigInvalidException(`Schema file "${label}" is missing a "collection".`);
	}

	if (isInternalTable(collection)) {
		throw new ConfigInvalidException(
			`Schema file "${label}" names internal table "${safeLogFragment(
				collection
			)}", which is not operator-managed schema.`
		);
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

	assertOwnedElements(fields, 'field', collection, filename);
	assertOwnedElements(relations, 'relation', collection, filename);

	if (collection.startsWith('directus_') && (Object.hasOwn(record, 'meta') || Object.hasOwn(record, 'schema'))) {
		throw new ConfigInvalidException(
			`Schema file "${label}" for system collection "${safeLogFragment(
				collection
			)}" must declare only fields, not a collection definition.`
		);
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

function toChanges(_plan: KindPlan<SchemaKindTypes>, _enrichment: ConfigPlanEnrichment): ConfigPlanChange[] {
	return [];
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

		// A system collection is operator-managed through its fields alone. Its definition belongs to the
		// platform, so it is emitted without meta or schema even when the snapshot carries an override.
		if (name.startsWith('directus_')) {
			records.push({ collection: name, ...membersOf(name) });
			continue;
		}

		records.push({ collection: name, meta: collection.meta, schema: collection.schema, ...membersOf(name) });
	}

	// A system collection with only operator-added fields never reaches the snapshot's collections.
	for (const owner of [...fieldsByCollection.keys(), ...relationsByCollection.keys()]) {
		if (emitted.has(owner)) continue;
		emitted.add(owner);

		records.push({ collection: owner, ...membersOf(owner) });
	}

	records.sort((a, b) => compareCodeUnits(a.collection, b.collection));

	return records;
}

async function readCurrent(context: ReadContext<SchemaKindTypes>): Promise<ReadCurrentResult<SchemaKindTypes>> {
	const snapshot = await getSnapshot({ database: context.database, schema: context.schema });
	const portable = await getPortableSnapshot(snapshot, { database: context.database });
	const records = groupSnapshotCollections(portable);

	return {
		records,
		documentIdentities: records.map((record) => ({ collection: record.collection })),
		dependencyState: undefined,
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
	identityOfDelete: () => unsupported('planning'),
	canonicalizeValues: () => unsupported('planning'),
	toCreateEntry: () => unsupported('planning'),
	toUpdateEntry: () => unsupported('planning'),
	toDeleteEntry: () => unsupported('planning'),
	handler: {
		readCurrent,
		projectReadState,
		validateDesired: () => unsupported('validation'),
		postPlan: () => unsupported('planning'),
		enrich: async () => unsupported('planning'),
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
