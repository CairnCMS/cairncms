import type { Field, Relation } from '@cairncms/types';
import type { Diff, DiffDeleted, DiffNew } from 'deep-diff';
import deepDiff from 'deep-diff';
import type { Knex } from 'knex';
import { cloneDeep, merge, set } from 'lodash-es';
import { flushCaches } from '../cache.js';
import { ALIAS_TYPES } from '../constants.js';
import { runInBoundSerializable } from '../database/bound-transaction.js';
import { getHelpers } from '../database/helpers/index.js';
import getDatabase, { getDatabaseClient } from '../database/index.js';
import { isSerializationConflict } from '../database/serialization-error.js';
import emitter from '../emitter.js';
import { SchemaApplyFailedException } from '../exceptions/schema-apply-failed.js';
import {
	SchemaPostCommitFailedException,
	type SchemaPostCommitPhase,
} from '../exceptions/schema-post-commit-failed.js';
import { SchemaStateChangedException } from '../exceptions/schema-state-changed.js';
import logger from '../logger.js';
import { CollectionsService } from '../services/collections.js';
import { FieldsService } from '../services/fields.js';
import { RelationsService } from '../services/relations.js';
import type {
	ActionEventParams,
	Collection,
	MutationOptions,
	SchemaOperation,
	SchemaPersistedState,
	Snapshot,
	SnapshotDiff,
	SnapshotField,
} from '../types/index.js';
import { DiffKind } from '../types/index.js';
import { assertSchemaDiffApplicable } from './assert-schema-diff-applicable.js';
import { readFolderKeys, toFolderIds, toKeyFormSnapshot } from './folder-references.js';
import { getSchema } from './get-schema.js';
import { getSnapshot } from './get-snapshot.js';
import { getVersionedHash } from './get-versioned-hash.js';
import { isNestedMetaUpdate } from './is-nested-meta-update.js';
import {
	type FacetApplicability,
	readSchemaObservedState,
	schemaStateVerifiedReverted,
	type SchemaTouchedEntities,
} from './read-schema-observed-state.js';
import { collectionDeleteOrder } from './schema-collection-order.js';

type CollectionDelta = {
	collection: string;
	diff: Diff<Collection | undefined>[];
};

type FieldWrites = Map<string, Map<string, SnapshotField>>;

function rebuildFromDiff<T>(current: T, diff: Diff<any>[]): T {
	return diff.reduce((acc, currentDiff) => {
		deepDiff.applyChange(acc, undefined, currentDiff);
		return acc;
	}, cloneDeep(current));
}

function isFieldUpdate(diff: Diff<any>[]): boolean {
	return diff?.[0]?.kind === DiffKind.EDIT || diff?.[0]?.kind === DiffKind.ARRAY || isNestedMetaUpdate(diff[0]!);
}

function operationOf(diff: Diff<any>[]): SchemaOperation {
	if (diff?.[0]?.kind === DiffKind.NEW && !isNestedMetaUpdate(diff[0]!)) return 'create';
	if (diff?.[0]?.kind === DiffKind.DELETE && !isNestedMetaUpdate(diff[0]!)) return 'delete';
	return 'update';
}

function changedDefinition(diff: Diff<any>[]): any {
	const change = diff?.[0];
	if (change?.kind === DiffKind.NEW) return (change as DiffNew<any>).rhs;
	if (change?.kind === DiffKind.DELETE) return (change as DiffDeleted<any>).lhs;
	return undefined;
}

function collectionTableApplicability(definition: any): FacetApplicability {
	return definition?.schema != null ? 'yes' : 'no';
}

function collectionMetadataApplicability(definition: any): FacetApplicability {
	return definition?.meta != null ? 'yes' : 'no';
}

function fieldColumnApplicability(operation: SchemaOperation, definition: any): FacetApplicability {
	const type = definition?.type;
	if (typeof type !== 'string') return 'no';
	if (ALIAS_TYPES.includes(type)) return 'no';
	// Creation skips the 'unknown' type in the column builder, but deletion drops any non-alias column.
	if (operation === 'create' && type === 'unknown') return 'no';
	return 'yes';
}

function fieldMetadataApplicability(operation: SchemaOperation, definition: any): FacetApplicability {
	if (definition?.meta != null) return 'yes';
	if (operation === 'delete') return 'no';
	return 'unknown';
}

function relationMetadataApplicability(operation: SchemaOperation, definition: any): FacetApplicability {
	if (operation === 'create') return 'yes';
	if (operation === 'delete') return definition?.meta != null ? 'yes' : 'no';
	return 'yes';
}

function resolveFieldWrites(
	currentSnapshot: Snapshot,
	snapshotDiff: SnapshotDiff,
	folderIdByKey: ReadonlyMap<string, string>
): FieldWrites {
	const writes: FieldWrites = new Map();

	for (const { collection, field, diff } of snapshotDiff.fields) {
		let finalField: SnapshotField | undefined;

		if (diff?.[0]?.kind === DiffKind.NEW && !isNestedMetaUpdate(diff?.[0])) {
			finalField = (diff[0] as DiffNew<SnapshotField>).rhs;
		} else if (isFieldUpdate(diff)) {
			const currentField = currentSnapshot.fields.find(
				(snapshotField) => snapshotField.collection === collection && snapshotField.field === field
			);

			if (currentField) finalField = rebuildFromDiff(currentField, diff);
		}

		if (finalField === undefined) continue;

		if (!writes.has(collection)) writes.set(collection, new Map());
		writes.get(collection)!.set(field, toFolderIds(finalField, folderIdByKey));
	}

	return writes;
}

export async function applyDiff(
	snapshotDiff: SnapshotDiff,
	options: { database?: Knex; expectedHash: string }
): Promise<void> {
	const database = options.database ?? getDatabase();
	const helpers = getHelpers(database);
	const vendor = getDatabaseClient(database);

	const nestedActionEvents: ActionEventParams[] = [];

	const mutationOptions: MutationOptions = {
		autoPurgeSystemCache: false,
		bypassEmitAction: (params) => nestedActionEvents.push(params),
		bypassLimits: true,
	};

	const touched: SchemaTouchedEntities = {
		collections: snapshotDiff.collections.map(({ collection, diff }) => {
			const definition = changedDefinition(diff);

			return {
				collection,
				operation: operationOf(diff),
				table: collectionTableApplicability(definition),
				metadata: collectionMetadataApplicability(definition),
			};
		}),
		fields: snapshotDiff.fields.map(({ collection, field, diff }) => {
			const operation = operationOf(diff);
			const definition = changedDefinition(diff);

			return {
				collection,
				field,
				operation,
				column: fieldColumnApplicability(operation, definition),
				metadata: fieldMetadataApplicability(operation, definition),
			};
		}),
		relations: snapshotDiff.relations.map(({ collection, field, diff }) => {
			const operation = operationOf(diff);
			const definition = changedDefinition(diff);

			return {
				collection,
				field,
				operation,
				metadata: relationMetadataApplicability(operation, definition),
			};
		}),
	};

	let writesStarted = false;
	let committed = false;

	const runPostColumnChange = await helpers.schema.preColumnChange();

	const restoreForeignKeys = async (): Promise<boolean> => {
		if (!runPostColumnChange) return true;

		try {
			await helpers.schema.postColumnChange();
			return true;
		} catch {
			logger.error('Failed to restore foreign key enforcement after a schema apply');
			return false;
		}
	};

	try {
		await runInBoundSerializable(
			database,
			async (trx) => {
				const schema = await getSchema({ database: trx, bypassCache: true });
				const currentSnapshot = await getSnapshot({ database: trx, schema });
				const currentKeyForm = await toKeyFormSnapshot(currentSnapshot, { database: trx });

				if (getVersionedHash(currentKeyForm.snapshot) !== options.expectedHash) {
					throw new SchemaStateChangedException();
				}

				assertSchemaDiffApplicable(snapshotDiff, currentSnapshot, schema);

				const { folderIdByKey } = await readFolderKeys(trx);
				const fieldWrites = resolveFieldWrites(currentSnapshot, snapshotDiff, folderIdByKey);
				const fieldWrite = (collection: string, field: string) => fieldWrites.get(collection)?.get(field);

				const collectionsService = new CollectionsService({ knex: trx, schema });

				const getNestedCollectionsToCreate = (currentLevelCollection: string) =>
					snapshotDiff.collections.filter(
						({ diff }) => (diff[0] as DiffNew<Collection>).rhs?.meta?.group === currentLevelCollection
					) as CollectionDelta[];

				const createCollections = async (collections: CollectionDelta[]) => {
					for (const { collection, diff } of collections) {
						if (diff?.[0]?.kind === DiffKind.NEW && !isNestedMetaUpdate(diff?.[0]) && diff[0].rhs) {
							// We'll nest the to-be-created fields in the same collection creation, to prevent
							// creating a collection without a primary key
							const fields = snapshotDiff.fields
								.filter((fieldDiff) => fieldDiff.collection === collection)
								.map(
									(fieldDiff) =>
										fieldWrite(fieldDiff.collection, fieldDiff.field) ?? (fieldDiff.diff[0] as DiffNew<Field>).rhs
								)
								.map((fieldDiff) => {
									// Casts field type to UUID when applying non-PostgreSQL schema onto PostgreSQL database.
									// This is needed because they snapshots UUID fields as char/varchar with length 36.
									if (
										['char', 'varchar'].includes(String(fieldDiff.schema?.data_type).toLowerCase()) &&
										fieldDiff.schema?.max_length === 36 &&
										(fieldDiff.schema?.is_primary_key ||
											(fieldDiff.schema?.foreign_key_table && fieldDiff.schema?.foreign_key_column))
									) {
										return merge(fieldDiff, { type: 'uuid', schema: { data_type: 'uuid', max_length: null } });
									} else {
										return fieldDiff;
									}
								});

							try {
								await collectionsService.createOne(
									{
										...diff[0].rhs,
										fields,
									},
									mutationOptions
								);
							} catch (err: any) {
								logger.error(`Failed to create collection "${collection}"`);
								throw err;
							}

							// Now that the fields are in for this collection, we can strip them from the field edits
							snapshotDiff.fields = snapshotDiff.fields.filter((fieldDiff) => fieldDiff.collection !== collection);

							await createCollections(getNestedCollectionsToCreate(collection));
						}
					}
				};

				const deleteCollection = async (collection: string) => {
					const relations = schema.relations.filter(
						(r) => r.related_collection === collection || r.collection === collection
					);

					if (relations.length > 0) {
						const relationsService = new RelationsService({ knex: trx, schema });

						for (const relation of relations) {
							try {
								await relationsService.deleteOne(relation.collection, relation.field, mutationOptions);
							} catch (err) {
								logger.error(
									`Failed to delete collection "${collection}" due to relation "${relation.collection}.${relation.field}"`
								);

								throw err;
							}
						}

						// clean up deleted relations from existing schema
						schema.relations = schema.relations.filter(
							(r) => r.related_collection !== collection && r.collection !== collection
						);
					}

					try {
						await collectionsService.deleteOne(collection, mutationOptions);
					} catch (err) {
						logger.error(`Failed to delete collection "${collection}"`);
						throw err;
					}
				};

				// Finds all collections that need to be created
				const filterCollectionsForCreation = ({
					diff,
				}: {
					collection: string;
					diff: Diff<Collection | undefined>[];
				}) => {
					// Check new collections only
					const isNewCollection = diff[0]?.kind === DiffKind.NEW && !isNestedMetaUpdate(diff[0]);
					if (!isNewCollection) return false;

					// Create now if no group
					const groupName = (diff[0] as DiffNew<Collection>).rhs.meta?.group;
					if (!groupName) return true;

					// Check if parent collection already exists in schema
					const parentExists = currentSnapshot.collections.find((c) => c.collection === groupName) !== undefined;

					// If this is a new collection and the parent collection doesn't exist in current schema ->
					// Check if the parent collection will be created as part of applying this snapshot ->
					// If yes -> this collection will be created recursively
					// If not -> create now
					// (ex.)
					// TopLevelCollection - I exist in current schema
					// 		NestedCollection - I exist in snapshotDiff as a new collection
					//			TheCurrentCollectionInIteration - I exist in snapshotDiff as a new collection but will be created as part of NestedCollection
					const parentWillBeCreatedInThisApply =
						snapshotDiff.collections.filter(
							({ collection, diff }) =>
								diff[0]?.kind === DiffKind.NEW && !isNestedMetaUpdate(diff[0]) && collection === groupName
						).length > 0;

					// Has group, but parent is not new, parent is also not being created in this snapshot apply
					if (parentExists && !parentWillBeCreatedInThisApply) return true;

					return false;
				};

				writesStarted = true;

				// Create top level collections (no group, or highest level in existing group) first,
				// then continue with nested collections recursively
				await createCollections(snapshotDiff.collections.filter(filterCollectionsForCreation));

				for (const collection of collectionDeleteOrder(snapshotDiff)) {
					await deleteCollection(collection);
				}

				for (const { collection, diff } of snapshotDiff.collections) {
					if (
						diff?.[0]?.kind === DiffKind.EDIT ||
						diff?.[0]?.kind === DiffKind.ARRAY ||
						isNestedMetaUpdate(diff?.[0])
					) {
						const currentCollection = currentSnapshot.collections.find((field) => {
							return field.collection === collection;
						});

						if (currentCollection) {
							try {
								const newValues = diff.reduce((acc, currentDiff) => {
									deepDiff.applyChange(acc, undefined, currentDiff);
									return acc;
								}, cloneDeep(currentCollection));

								await collectionsService.updateOne(collection, newValues, mutationOptions);
							} catch (err) {
								logger.error(`Failed to update collection "${collection}"`);
								throw err;
							}
						}
					}
				}

				const fieldsService = new FieldsService({
					knex: trx,
					schema: await getSchema({ database: trx, bypassCache: true }),
				});

				for (const { collection, field, diff } of snapshotDiff.fields) {
					if (diff?.[0]?.kind === DiffKind.NEW && !isNestedMetaUpdate(diff?.[0])) {
						try {
							await fieldsService.createField(
								collection,
								fieldWrite(collection, field) ?? (diff[0] as DiffNew<Field>).rhs,
								undefined,
								mutationOptions
							);
						} catch (err) {
							logger.error(`Failed to create field "${collection}.${field}"`);
							throw err;
						}
					}

					if (isFieldUpdate(diff)) {
						const newValues = fieldWrite(collection, field);

						if (newValues) {
							try {
								await fieldsService.updateField(collection, newValues, mutationOptions);
							} catch (err) {
								logger.error(`Failed to update field "${collection}.${field}"`);
								throw err;
							}
						}
					}

					if (diff?.[0]?.kind === DiffKind.DELETE && !isNestedMetaUpdate(diff?.[0])) {
						try {
							await fieldsService.deleteField(collection, field, mutationOptions);
						} catch (err) {
							logger.error(`Failed to delete field "${collection}.${field}"`);
							throw err;
						}

						// Field deletion also cleans up the relationship. We should ignore any relationship
						// changes attached to this now non-existing field
						snapshotDiff.relations = snapshotDiff.relations.filter(
							(relation) => (relation.collection === collection && relation.field === field) === false
						);
					}
				}

				const relationsService = new RelationsService({
					knex: trx,
					schema: await getSchema({ database: trx, bypassCache: true }),
				});

				for (const { collection, field, diff } of snapshotDiff.relations) {
					const structure = {};

					for (const diffEdit of diff) {
						set(structure, diffEdit.path!, undefined);
					}

					if (diff?.[0]?.kind === DiffKind.NEW) {
						try {
							await relationsService.createOne(
								{
									...(diff[0] as DiffNew<Relation>).rhs,
									collection,
									field,
								},
								mutationOptions
							);
						} catch (err) {
							logger.error(`Failed to create relation "${collection}.${field}"`);
							throw err;
						}
					}

					if (diff?.[0]?.kind === DiffKind.EDIT || diff?.[0]?.kind === DiffKind.ARRAY) {
						const currentRelation = currentSnapshot.relations.find((relation) => {
							return relation.collection === collection && relation.field === field;
						});

						if (currentRelation) {
							try {
								const newValues = diff.reduce((acc, currentDiff) => {
									deepDiff.applyChange(acc, undefined, currentDiff);
									return acc;
								}, cloneDeep(currentRelation));

								await relationsService.updateOne(collection, field, newValues, mutationOptions);
							} catch (err) {
								logger.error(`Failed to update relation "${collection}.${field}"`);
								throw err;
							}
						}
					}

					if (diff?.[0]?.kind === DiffKind.DELETE) {
						try {
							await relationsService.deleteOne(collection, field, mutationOptions);
						} catch (err) {
							logger.error(`Failed to delete relation "${collection}.${field}"`);
							throw err;
						}
					}
				}
			},
			async () => {
				committed = true;

				const foreignKeysRestored = await restoreForeignKeys();

				let cacheFailed = false;

				try {
					await flushCaches(true);
				} catch {
					cacheFailed = true;
				}

				if (!foreignKeysRestored) {
					throw new SchemaPostCommitFailedException(cacheFailed ? 'foreign_keys_and_cache' : 'foreign_keys');
				}

				let actionFailed = false;

				try {
					if (nestedActionEvents.length > 0) {
						const updatedSchema = await getSchema({ database, bypassCache: true });

						for (const nestedActionEvent of nestedActionEvents) {
							nestedActionEvent.context.schema = updatedSchema;

							await emitter.emitActionAndWait(
								nestedActionEvent.event,
								nestedActionEvent.meta,
								nestedActionEvent.context
							);
						}
					}
				} catch {
					actionFailed = true;
				}

				if (cacheFailed || actionFailed) {
					throw new SchemaPostCommitFailedException(postCommitPhase(cacheFailed, actionFailed));
				}
			}
		);
	} catch (err) {
		if (committed) throw err;

		const foreignKeysRestored = await restoreForeignKeys();

		// A serialization conflict unwinds the whole transaction only on PostgreSQL and SQLite, where
		// it is a clean rollback. MySQL and MariaDB commit data definition changes implicitly, so a
		// conflict there can follow a committed change and is reported as a persisted outcome instead.
		if (isSerializationConflict(err) && foreignKeysRestored && (vendor === 'postgres' || vendor === 'sqlite')) {
			throw new SchemaStateChangedException();
		}

		if (!writesStarted && foreignKeysRestored) throw err;

		const persisted = await readObservedStateOrUnknown(database, touched);

		// On PostgreSQL and SQLite the apply is one transaction. A verified-reverted observed state
		// means every touched change is gone and nothing is left unverified, so it fully unwound and
		// the original failure is a clean rollback. An unknown facet keeps the outcome uncertain.
		if (
			foreignKeysRestored &&
			persisted !== 'unknown' &&
			(vendor === 'postgres' || vendor === 'sqlite') &&
			schemaStateVerifiedReverted(persisted)
		) {
			throw err;
		}

		await forceCacheClear();
		throw new SchemaApplyFailedException(persisted, { cause: err, foreignKeysRestored });
	}
}

function postCommitPhase(cacheFailed: boolean, actionFailed: boolean): SchemaPostCommitPhase {
	if (cacheFailed && actionFailed) return 'cache_and_actions';
	if (cacheFailed) return 'cache';
	return 'actions';
}

async function readObservedStateOrUnknown(
	database: Knex,
	touched: SchemaTouchedEntities
): Promise<SchemaPersistedState | 'unknown'> {
	try {
		return await readSchemaObservedState(database, touched);
	} catch {
		return 'unknown';
	}
}

async function forceCacheClear(): Promise<void> {
	try {
		await flushCaches(true);
	} catch {
		logger.error('Failed to clear caches after a partial or unknown schema apply');
	}
}
