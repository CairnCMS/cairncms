import { normalizeConfigKey } from '@cairncms/utils';
import { withMutationGuard } from '../../../database/mutation-guard.js';
import { ConfigFolderInUseException } from '../../../exceptions/config-folder-in-use.js';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import { FoldersService } from '../../../services/folders.js';
import { FolderDeletionGuard } from '../folder-deletion-guard.js';
import { resolveFolderReference } from '../folder-id-lookup.js';
import { normalizeFolderImpact, readFolderDeletionImpact } from './folders-impact.js';
import type {
	ConfigFailure,
	ConfigFolder,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	FolderDeletionImpactEntry,
	FolderFieldChanges,
	FolderIdentity,
	FolderValues,
} from '../../../types/config.js';
import { CONFIG_FILENAME_STEM_MAX_LENGTH, FOLDER_NAME_MAX_LENGTH } from '../../config-contract.js';
import { safeLogFragment } from '../../safe-log-fragment.js';
import { compareCodeUnits } from '../canonical-encode.js';
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
import { identityConflict, invalid } from '../failures.js';
import { UNFILTERED, unreadable } from '../read-parsing.js';
import { changesToValues, composeValues } from '../values.js';

const NON_SECRET: FieldSensitivity = { secret: false, redact: 'none' };

export interface FoldersKindTypes {
	Kind: 'folders';
	Document: ConfigFolder;
	Record: ConfigFolder;
	Values: FolderValues;
	Identity: FolderIdentity;
	DocumentIdentity: FolderIdentity;
	Create: ConfigFolder;
	Update: { key: string; changes: FolderFieldChanges };
	Delete: string;
	Changes: FolderFieldChanges;
	ReadDependencyState: { currentFolderKeys: ReadonlySet<string>; folderKeyById: Map<string, string> };
	ApplyDependencyState: { folderIdByKey: Map<string, string> };
	ReadDependencies: NoConfigDependencies;
	PlanDependencies: NoConfigDependencies;
	ApplyDependencies: NoConfigDependencies;
	Enrichment: { folderDeletionImpact: Map<string, FolderDeletionImpactEntry[]> };
	ResultSlice: { created: string[]; updated: string[]; deleted: string[] };
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
	maxLength: CONFIG_FILENAME_STEM_MAX_LENGTH,
	grammar: 'config-key',
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
		maxLength: FOLDER_NAME_MAX_LENGTH,
		acceptsPlaceholder: false,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: false,
	},
	{
		name: 'parent',
		type: 'string',
		required: false,
		nullable: true,
		grammar: 'config-key',
		maxLength: CONFIG_FILENAME_STEM_MAX_LENGTH,
		acceptsPlaceholder: false,
		canonicalize: (value) => value ?? null,
		sensitivity: NON_SECRET,
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: true,
	},
];

const VALUE_FIELD_ORDER = ['name', 'parent'] as const;

function assertFolderIdentity(folder: Record<string, any>): void {
	const id = folder['id'];

	if (typeof id !== 'string' || id === '') {
		throw unreadable('a folder row', 'column "id" is not a non-empty string');
	}

	const key = folder['key'];

	if (typeof key !== 'string' || key === '' || normalizeConfigKey(key) !== key) {
		throw unreadable(`folder id=${safeLogFragment(id)}`, `column "key" is not a usable folder key`);
	}
}

function requireColumn(folder: Record<string, any>, field: string): any {
	if (folder[field] === undefined) {
		throw unreadable(
			`folder id=${safeLogFragment(folder['id'])}`,
			`column "${field}" was absent from the row, so the read is incomplete`
		);
	}

	return folder[field];
}

async function readCurrent(context: ReadContext<FoldersKindTypes>): Promise<ReadCurrentResult<FoldersKindTypes>> {
	const foldersService = new FoldersService({ knex: context.database, schema: context.schema });
	const full = context.readMode === 'full';
	const query = full ? { limit: -1 } : { limit: -1, fields: ['id', 'key'] };
	const rows = await foldersService.readByQuery(query, UNFILTERED);

	const folderKeyById = new Map<string, string>();
	const currentFolderKeys = new Set<string>();

	for (const folder of rows) {
		assertFolderIdentity(folder);
		folderKeyById.set(folder['id'], folder['key']);
		currentFolderKeys.add(folder['key']);
	}

	const records: ConfigFolder[] = [];

	if (full) {
		for (const folder of rows) {
			const parentId = requireColumn(folder, 'parent');

			const parentKey =
				parentId === null ? null : (await resolveFolderReference(context.database, folderKeyById, parentId)) ?? null;

			if (parentId !== null && parentKey === null) {
				throw unreadable(`folder id=${safeLogFragment(folder['id'])}`, `column "parent" points to an unknown folder`);
			}

			records.push({ key: folder['key'], name: requireColumn(folder, 'name'), parent: parentKey });
		}
	}

	records.sort((a, b) => a.key.localeCompare(b.key));

	return {
		records,
		documentIdentities: records.map((record) => ({ key: record.key })),
		dependencyState: { currentFolderKeys, folderKeyById },
	};
}

function projectReadState(result: ReadCurrentResult<FoldersKindTypes>, mode: ConfigReadMode): ReadStateProjection {
	if (mode === 'identity') {
		return { mode, identities: [...result.dependencyState.currentFolderKeys].sort(compareCodeUnits) };
	}

	const values = result.records
		.map((record): [string, unknown] => [
			record.key,
			composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>),
		])
		.sort((a, b) => compareCodeUnits(a[0], b[0]));

	return { mode, identities: values.map(([key]) => key), values };
}

function validateDesired(
	documents: ConfigFolder[],
	_records: ConfigFolder[],
	context: ValidationContext
): ConfigFailure[] {
	const failures: ConfigFailure[] = [];
	const keys = new Set<string>();

	for (const document of documents) {
		if (keys.has(document.key)) {
			failures.push(identityConflict(`Duplicate folder "${safeLogFragment(document.key)}".`));
		}

		keys.add(document.key);
	}

	const currentParents = context.references === 'current-state' ? context.currentFolderParents : undefined;
	// An omitted parent (the property is absent) preserves the current parent, which is root for a new folder. An
	// explicit null is root. A server snapshot always writes parent explicitly, so it never consults current state.
	const declaresParent = (document: ConfigFolder): boolean => Object.hasOwn(document, 'parent');
	const preservesParent = documents.some((document) => !declaresParent(document));

	if (context.references === 'current-state' && preservesParent && currentParents === undefined) {
		throw unreadable('folder parent preservation', 'current folder state was not supplied');
	}

	const effectiveParent = (document: ConfigFolder): string | null =>
		declaresParent(document) ? document.parent ?? null : currentParents?.get(document.key) ?? null;

	for (const document of documents) {
		const parent = effectiveParent(document);

		if (parent === document.key) {
			failures.push(invalid(`Folder "${safeLogFragment(document.key)}" cannot be its own parent.`));
			continue;
		}

		if (declaresParent(document) && parent !== null && !keys.has(parent)) {
			failures.push(
				invalid(
					`Folder "${safeLogFragment(document.key)}" references parent "${safeLogFragment(
						parent
					)}", which is not a managed folder.`
				)
			);
		}
	}

	const parentByKey = new Map(documents.map((document) => [document.key, effectiveParent(document)] as const));
	const inCycle = new Set<string>();

	for (const document of documents) {
		if (inCycle.has(document.key)) continue;

		const path: string[] = [];
		const onPath = new Set<string>();
		let cursor: string | null = document.key;

		while (cursor !== null && parentByKey.has(cursor)) {
			if (inCycle.has(cursor)) break;

			if (onPath.has(cursor)) {
				const cycle = path.slice(path.indexOf(cursor));
				for (const key of cycle) inCycle.add(key);

				if (cycle.length > 1) {
					failures.push(
						invalid(`Folders ${cycle.map((key) => `"${safeLogFragment(key)}"`).join(', ')} form a parent cycle.`)
					);
				}

				break;
			}

			path.push(cursor);
			onPath.add(cursor);
			cursor = parentByKey.get(cursor) ?? null;
		}
	}

	return failures;
}

async function enrich(
	plan: KindPlan<FoldersKindTypes>,
	_records: ConfigFolder[],
	context: EnrichContext
): Promise<FoldersKindTypes['Enrichment']> {
	return { folderDeletionImpact: await readFolderDeletionImpact(plan, context.database) };
}

function emptyEnrichment(): FoldersKindTypes['Enrichment'] {
	return { folderDeletionImpact: new Map() };
}

function toChanges(plan: KindPlan<FoldersKindTypes>, enrichment: ConfigPlanEnrichment): ConfigPlanChange[] {
	const changes: ConfigPlanChange[] = [];

	for (const folder of plan.create) {
		changes.push({
			kind: 'folders',
			operation: 'create',
			identity: { key: folder.key },
			values: composeValues(
				RECORD_FIELDS,
				VALUE_FIELD_ORDER,
				folder as unknown as Record<string, unknown>
			) as FolderValues,
		});
	}

	for (const update of plan.update) {
		changes.push({ kind: 'folders', operation: 'update', identity: { key: update.key }, fields: update.changes });
	}

	for (const key of plan.delete) {
		changes.push({
			kind: 'folders',
			operation: 'delete',
			identity: { key },
			impact: normalizeFolderImpact(enrichment.folderDeletionImpact.get(key)),
		});
	}

	return changes;
}

function topoSortCreates(creates: ConfigFolder[]): ConfigFolder[] {
	const byKey = new Map(creates.map((folder) => [folder.key, folder]));
	const sorted: ConfigFolder[] = [];
	const visited = new Set<string>();

	const visit = (folder: ConfigFolder): void => {
		if (visited.has(folder.key)) return;
		visited.add(folder.key);

		const parentKey = folder.parent ?? null;

		if (parentKey !== null && byKey.has(parentKey)) {
			visit(byKey.get(parentKey)!);
		}

		sorted.push(folder);
	};

	for (const folder of creates) visit(folder);
	return sorted;
}

async function applyCreates(
	creates: ConfigFolder[],
	context: ApplyContext<FoldersKindTypes>
): Promise<Extract<FoldersKindTypes['Outcome'], { op: 'create' }>> {
	const created: string[] = [];
	if (creates.length === 0) return { op: 'create', created };

	const foldersService = new FoldersService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});

	const existing = await context.database('directus_folders').select('id', 'key');
	const folderIdByKey = new Map<string, string>(existing.map((row) => [row['key'], row['id']]));

	for (const folder of topoSortCreates(creates)) {
		const parentKey = folder.parent ?? null;
		const parentId = parentKey === null ? null : folderIdByKey.get(parentKey) ?? null;

		if (parentKey !== null && parentId === null) {
			throw new Error(`Parent folder "${parentKey}" not found during apply of "${folder.key}".`);
		}

		const id = await foldersService.createOne(
			{ key: folder.key, name: folder.name, parent: parentId },
			context.mutationOptions
		);

		folderIdByKey.set(folder.key, String(id));
		created.push(folder.key);
	}

	return { op: 'create', created };
}

function orderReparents(
	reparents: FoldersKindTypes['Update'][],
	desiredParentByKey: Map<string, string | null>
): FoldersKindTypes['Update'][] {
	const depthOf = (key: string): number => {
		let depth = 0;
		const seen = new Set<string>([key]);
		let cursor = desiredParentByKey.get(key) ?? null;

		while (cursor !== null && !seen.has(cursor)) {
			depth++;
			seen.add(cursor);
			cursor = desiredParentByKey.get(cursor) ?? null;
		}

		return depth;
	};

	return [...reparents].sort((a, b) => depthOf(a.key) - depthOf(b.key));
}

async function applyUpdates(
	updates: FoldersKindTypes['Update'][],
	context: ApplyContext<FoldersKindTypes>
): Promise<Extract<FoldersKindTypes['Outcome'], { op: 'update' }>> {
	const updated: string[] = [];
	if (updates.length === 0) return { op: 'update', updated };

	const foldersService = new FoldersService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});

	const rows = await context.database('directus_folders').select('id', 'key', 'parent');
	const folderIdByKey = new Map<string, string>(rows.map((row) => [row['key'], row['id']]));
	const keyById = new Map<string, string>(rows.map((row) => [row['id'], row['key']]));

	const idFor = (key: string): string => {
		const id = folderIdByKey.get(key);
		if (!id) throw new Error(`Folder "${key}" not found during apply.`);
		return id;
	};

	const nameOnly = updates.filter((update) => update.changes.parent === undefined);
	const reparents = updates.filter((update) => update.changes.parent !== undefined);

	for (const update of nameOnly) {
		await foldersService.updateOne(idFor(update.key), changesToValues(update.changes), context.mutationOptions);
		updated.push(update.key);
	}

	const desiredParentByKey = new Map<string, string | null>();

	for (const row of rows) {
		const parentKey =
			row['parent'] === null ? null : (await resolveFolderReference(context.database, keyById, row['parent'])) ?? null;

		desiredParentByKey.set(row['key'], parentKey);
	}

	for (const update of reparents) desiredParentByKey.set(update.key, update.changes.parent!.after);

	for (const update of orderReparents(reparents, desiredParentByKey)) {
		const desiredParentKey = update.changes.parent!.after;
		const parentId = desiredParentKey === null ? null : idFor(desiredParentKey);

		await foldersService.updateOne(
			idFor(update.key),
			{ ...changesToValues(update.changes), parent: parentId },
			context.mutationOptions
		);

		updated.push(update.key);
	}

	return { op: 'update', updated };
}

async function applyDeletes(
	deletes: string[],
	context: ApplyContext<FoldersKindTypes>
): Promise<Extract<FoldersKindTypes['Outcome'], { op: 'delete' }>> {
	const deleted: string[] = [];
	if (deletes.length === 0) return { op: 'delete', deleted };

	const foldersService = new FoldersService({
		knex: context.database,
		schema: context.schema,
		accountability: context.securityContext.accountability,
	});

	const rows = await context.database('directus_folders').select('id', 'key', 'parent');
	const folderIdByKey = new Map<string, string>(rows.map((row) => [row['key'], row['id']]));
	const keyById = new Map<string, string>(rows.map((row) => [row['id'], row['key']]));

	const deleteSet = new Set(deletes);
	const childrenOf = new Map<string, string[]>();

	for (const row of rows) {
		const parentKey =
			row['parent'] === null ? null : (await resolveFolderReference(context.database, keyById, row['parent'])) ?? null;

		if (parentKey !== null && deleteSet.has(parentKey) && deleteSet.has(row['key'])) {
			const siblings = childrenOf.get(parentKey) ?? [];
			siblings.push(row['key']);
			childrenOf.set(parentKey, siblings);
		}
	}

	const ordered: string[] = [];
	const visited = new Set<string>();

	const visit = (key: string): void => {
		if (visited.has(key)) return;
		visited.add(key);
		for (const child of childrenOf.get(key) ?? []) visit(child);
		ordered.push(key);
	};

	for (const key of deletes) visit(key);

	const guardedOptions = withMutationGuard(context.mutationOptions, new FolderDeletionGuard());

	for (const key of ordered) {
		const id = folderIdByKey.get(key);
		if (!id) continue;

		try {
			await foldersService.deleteOne(id, guardedOptions);
		} catch (error) {
			if (error instanceof ConfigFolderInUseException) {
				const blockedBy = (error.extensions as { blockedBy?: unknown }).blockedBy;

				throw new ConfigFolderInUseException(
					`Cannot delete folder "${safeLogFragment(key)}" because it is still in use.`,
					{ key, ...(typeof blockedBy === 'string' ? { blockedBy } : {}) }
				);
			}

			throw error;
		}

		deleted.push(key);
	}

	return { op: 'delete', deleted };
}

async function readApplyDependencyState(
	context: ApplyContext<FoldersKindTypes>
): Promise<FoldersKindTypes['ApplyDependencyState']> {
	const rows = await context.database('directus_folders').select('id', 'key');
	const folderIdByKey = new Map<string, string>();
	for (const row of rows) folderIdByKey.set(row['key'], row['id']);
	return { folderIdByKey };
}

function emptyResult(): FoldersKindTypes['ResultSlice'] {
	return { created: [], updated: [], deleted: [] };
}

function mergeOutcome(
	slice: FoldersKindTypes['ResultSlice'],
	outcome: FoldersKindTypes['Outcome']
): FoldersKindTypes['ResultSlice'] {
	switch (outcome.op) {
		case 'create':
			return { ...slice, created: [...slice.created, ...outcome.created] };
		case 'update':
			return { ...slice, updated: [...slice.updated, ...outcome.updated] };
		case 'delete':
			return { ...slice, deleted: [...slice.deleted, ...outcome.deleted] };
	}
}

export const foldersDescriptor: ConfigResourceDescriptor<FoldersKindTypes> = {
	kind: 'folders',
	formatVersion: 2,
	dependencies: [],
	layout: {
		directory: 'folders',
		documentShape: 'flat',
		documentIdentityOf: (document) => ({ key: document.key }),
		filenameOf: (documentIdentity) => documentIdentity.key,
		parseDocumentFile: (record, filename) => {
			if (!record['key']) {
				throw new ConfigInvalidException(`Invalid folder file: ${filename} is missing a "key" field.`);
			}

			const expected = `${record['key']}.yaml`;

			if (filename !== expected) {
				throw new ConfigInvalidException(
					`Folder file "${filename}" contains key "${safeLogFragment(
						record['key']
					)}". The filename must match the key ("${safeLogFragment(expected)}").`
				);
			}

			return { ...record } as unknown as ConfigFolder;
		},
	},
	documentIdentityFields: [KEY_FIELD],
	recordFields: RECORD_FIELDS,
	valueFieldOrder: VALUE_FIELD_ORDER,
	emittedDocumentSubject: (identity) => ({ label: 'folder key', value: identity.key }),
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
		composeValues(RECORD_FIELDS, VALUE_FIELD_ORDER, record as unknown as Record<string, unknown>) as FolderValues,
	toCreateEntry: (record) => record,
	toUpdateEntry: (identity, changes) => ({ key: identity.key, changes }),
	toDeleteEntry: (identity) => identity.key,
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
