import type { Diff, DiffDeleted } from 'deep-diff';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotApplyTestSchema } from '../__utils__/schemas.js';
import {
	snapshotBeforeCreateCollection,
	snapshotBeforeDeleteCollection,
	snapshotCreateCollection,
	snapshotCreateCollectionNotNested,
} from '../__utils__/snapshots.js';
import { InvalidPayloadException } from '../exceptions/index.js';
import { CollectionsService, FieldsService, RelationsService } from '../services/index.js';
import type { CollectionMeta } from '../types/collection.js';
import type { Collection, Snapshot, SnapshotDiff, SnapshotField } from '../types/index.js';
import { applyDiff } from './apply-diff.js';
import { getTargetSnapshotDiff } from './get-target-snapshot-diff.js';
import { getSnapshot } from './get-snapshot.js';
import * as getSchema from './get-schema.js';

vi.mock('./get-snapshot.js', () => ({ getSnapshot: vi.fn() }));
vi.mock('./get-versioned-hash.js', () => ({ getVersionedHash: () => 'HASH' }));

vi.mock('../database/bound-transaction.js', () => ({
	runInBoundSerializable: async (database: any, fn: any, flush: any) => {
		const result = await database.transaction(fn);
		await flush({ events: [], responseCacheDirty: false, systemCacheDirty: false });
		return result;
	},
}));

class Client_PG extends MockClient {}

describe('applyDiff via target snapshot diff', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;

	const mutationOptions = {
		autoPurgeSystemCache: false,
		bypassEmitAction: expect.any(Function),
		bypassLimits: true,
	};

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: Client_PG }));
		tracker = createTracker(db);
		tracker.on.select('directus_folders').response([]);
	});

	afterEach(() => {
		tracker.reset();
		vi.clearAllMocks();
	});

	describe('Creating new collection(s)', () => {
		it('Creates new top-level collection(s)', async () => {
			const expected = {
				collection: 'test_table_2',
				meta: {
					accountability: 'all',
					collection: 'test_table_2',
					group: null,
					hidden: true,
					icon: 'import_export',
					item_duplication_fields: null,
					note: null,
					singleton: false,
					translations: {},
				},
				schema: { name: 'test_table_2' },
				fields: [
					{
						collection: 'test_table_2',
						field: 'id',
						meta: {
							collection: 'test_table_2',
							conditions: null,
							display: null,
							display_options: null,
							field: 'id',
							group: null,
							hidden: true,
							interface: null,
							note: null,
							options: null,
							readonly: false,
							required: false,
							sort: null,
							special: null,
							translations: {},
							validation: null,
							validation_message: null,
							width: 'full',
						},
						schema: {
							data_type: 'uuid',
							default_value: null,
							foreign_key_column: null,
							foreign_key_table: null,
							generation_expression: null,
							has_auto_increment: false,
							is_generated: false,
							is_nullable: false,
							is_primary_key: true,
							is_unique: true,
							max_length: null,
							name: 'id',
							numeric_precision: null,
							numeric_scale: null,
							table: 'test_table_2',
						},
						type: 'uuid',
					},
				],
			};

			// Stop call to db later on in apply-diff
			vi.spyOn(getSchema, 'getSchema').mockReturnValue(Promise.resolve(snapshotApplyTestSchema));
			// We are not actually testing that createOne works, just that is is called correctly
			const createOneCollectionSpy = vi.spyOn(CollectionsService.prototype, 'createOne').mockResolvedValue('test');
			const createFieldSpy = vi.spyOn(FieldsService.prototype, 'createField').mockResolvedValue();

			vi.mocked(getSnapshot).mockResolvedValue(snapshotBeforeCreateCollection);

			const diff = await getTargetSnapshotDiff(snapshotCreateCollectionNotNested, {
				current: snapshotBeforeCreateCollection,
				database: db,
			});

			await applyDiff(diff, { database: db, expectedHash: 'HASH' });

			expect(createOneCollectionSpy).toHaveBeenCalledTimes(1);
			expect(createOneCollectionSpy).toHaveBeenCalledWith(expected, mutationOptions);

			// There should be no fields left to create
			// they will get filtered in createCollections
			expect(createFieldSpy).toHaveBeenCalledTimes(0);
		});

		it('Creates the highest-level nested collection(s) with existing parents and any children', async () => {
			const expected = {
				collection: 'test_table_2',
				meta: {
					accountability: 'all',
					collection: 'test_table_2',
					group: 'test_table',
					hidden: true,
					icon: 'import_export',
					item_duplication_fields: null,
					note: null,
					singleton: false,
					translations: {},
				},
				schema: { name: 'test_table_2' },
				fields: [
					{
						collection: 'test_table_2',
						field: 'id',
						meta: {
							collection: 'test_table_2',
							conditions: null,
							display: null,
							display_options: null,
							field: 'id',
							group: null,
							hidden: true,
							interface: null,
							note: null,
							options: null,
							readonly: false,
							required: false,
							sort: null,
							special: null,
							translations: {},
							validation: null,
							validation_message: null,
							width: 'full',
						},
						schema: {
							data_type: 'uuid',
							default_value: null,
							foreign_key_column: null,
							foreign_key_table: null,
							generation_expression: null,
							has_auto_increment: false,
							is_generated: false,
							is_nullable: false,
							is_primary_key: true,
							is_unique: true,
							max_length: null,
							name: 'id',
							numeric_precision: null,
							numeric_scale: null,
							table: 'test_table_2',
						},
						type: 'uuid',
					},
				],
			};

			const expected2 = {
				collection: 'test_table_3',
				fields: [
					{
						collection: 'test_table_3',
						field: 'id',
						meta: {
							collection: 'test_table_3',
							conditions: null,
							display: null,
							display_options: null,
							field: 'id',
							group: null,
							hidden: true,
							interface: null,
							note: null,
							options: null,
							readonly: false,
							required: false,
							sort: null,
							special: null,
							translations: {},
							validation: null,
							validation_message: null,
							width: 'full',
						},
						schema: {
							data_type: 'uuid',
							default_value: null,
							foreign_key_column: null,
							foreign_key_table: null,
							generation_expression: null,
							has_auto_increment: false,
							is_generated: false,
							is_nullable: false,
							is_primary_key: true,
							is_unique: true,
							max_length: null,
							name: 'id',
							numeric_precision: null,
							numeric_scale: null,
							table: 'test_table_3',
						},
						type: 'uuid',
					},
				],
				meta: {
					accountability: 'all',
					collection: 'test_table_3',
					group: 'test_table_2',
					hidden: true,
					icon: 'import_export',
					item_duplication_fields: null,
					note: null,
					singleton: false,
					translations: {},
				},
				schema: { name: 'test_table_3' },
			};

			// Stop call to db later on in apply-diff
			vi.spyOn(getSchema, 'getSchema').mockReturnValue(Promise.resolve(snapshotApplyTestSchema));
			// We are not actually testing that createOne works, just that is is called correctly
			const createOneCollectionSpy = vi.spyOn(CollectionsService.prototype, 'createOne').mockResolvedValue('test');
			const createFieldSpy = vi.spyOn(FieldsService.prototype, 'createField').mockResolvedValue();

			vi.mocked(getSnapshot).mockResolvedValue(snapshotBeforeCreateCollection);

			const diff = await getTargetSnapshotDiff(snapshotCreateCollection, {
				current: snapshotBeforeCreateCollection,
				database: db,
			});

			await applyDiff(diff, { database: db, expectedHash: 'HASH' });

			expect(createOneCollectionSpy).toHaveBeenCalledTimes(2);
			expect(createOneCollectionSpy).toHaveBeenCalledWith(expected, mutationOptions);
			expect(createOneCollectionSpy).toHaveBeenCalledWith(expected2, mutationOptions);

			// There should be no fields left to create
			// they will get filtered in createCollections
			expect(createFieldSpy).toHaveBeenCalledTimes(0);
		});
	});

	describe('Creating new collection with UUID primary key field', () => {
		const fieldSchemaMaxLength = 36;

		it.each(['char', 'varchar'])(
			'casts non-postgres schema snapshots of UUID fields as %s(36) to UUID type',
			async (fieldSchemaDataType) => {
				const snapshotToApply: Snapshot = {
					version: 1,
					directus: '0.0.0',
					collections: [
						{
							collection: 'test_uuid_table',
							meta: {
								accountability: 'all',
								collection: 'test_uuid_table',
								group: null,
								hidden: true,
								icon: 'box',
								item_duplication_fields: null,
								note: null,
								singleton: false,
								translations: {},
							},
							schema: { name: 'test_uuid_table' },
						},
					],
					fields: [
						{
							collection: 'test_uuid_table',
							field: 'id',
							meta: {
								collection: 'test_uuid_table',
								conditions: null,
								display: null,
								display_options: null,
								field: 'id',
								group: null,
								hidden: true,
								interface: null,
								note: null,
								options: null,
								readonly: false,
								required: false,
								sort: null,
								special: null,
								translations: {},
								validation: null,
								validation_message: null,
								width: 'full',
							},
							schema: {
								comment: null,
								data_type: fieldSchemaDataType,
								default_value: null,
								foreign_key_column: null,
								foreign_key_schema: null,
								foreign_key_table: null,
								generation_expression: null,
								has_auto_increment: false,
								is_generated: false,
								is_nullable: false,
								is_primary_key: true,
								is_unique: true,
								max_length: fieldSchemaMaxLength,
								name: 'id',
								numeric_precision: null,
								numeric_scale: null,
								table: 'test_uuid_table',
							},
							type: 'uuid',
						} as SnapshotField,
					],
					relations: [],
				};

				const expected = {
					collection: 'test_uuid_table',
					meta: {
						accountability: 'all',
						collection: 'test_uuid_table',
						group: null,
						hidden: true,
						icon: 'box',
						item_duplication_fields: null,
						note: null,
						singleton: false,
						translations: {},
					},
					schema: { name: 'test_uuid_table' },
					fields: [
						{
							collection: 'test_uuid_table',
							field: 'id',
							meta: {
								collection: 'test_uuid_table',
								conditions: null,
								display: null,
								display_options: null,
								field: 'id',
								group: null,
								hidden: true,
								interface: null,
								note: null,
								options: null,
								readonly: false,
								required: false,
								sort: null,
								special: null,
								translations: {},
								validation: null,
								validation_message: null,
								width: 'full',
							},
							schema: {
								data_type: 'uuid',
								default_value: null,
								foreign_key_column: null,
								foreign_key_table: null,
								generation_expression: null,
								has_auto_increment: false,
								is_generated: false,
								is_nullable: false,
								is_primary_key: true,
								is_unique: true,
								max_length: null,
								name: 'id',
								numeric_precision: null,
								numeric_scale: null,
								table: 'test_uuid_table',
							},
							type: 'uuid',
						},
					],
				};

				// Stop call to db later on in apply-diff
				vi.spyOn(getSchema, 'getSchema').mockReturnValue(Promise.resolve(snapshotApplyTestSchema));
				// We are not actually testing that createOne works, just that is is called with the right data type
				const createOneCollectionSpy = vi.spyOn(CollectionsService.prototype, 'createOne').mockResolvedValue('test');
				vi.spyOn(FieldsService.prototype, 'createField').mockResolvedValue();

				const current: Snapshot = {
					version: 1,
					directus: '0.0.0',
					collections: [],
					fields: [],
					relations: [],
				};

				vi.mocked(getSnapshot).mockResolvedValue(current);

				const diff = await getTargetSnapshotDiff(snapshotToApply, { current, database: db });

				await applyDiff(diff, { database: db, expectedHash: 'HASH' });

				expect(createOneCollectionSpy).toHaveBeenCalledOnce();
				expect(createOneCollectionSpy).toHaveBeenCalledWith(expected, mutationOptions);
			}
		);
	});

	describe('Delete collections', () => {
		it('Deletes interrelated collections', async () => {
			const snapshotToApply: Snapshot = {
				version: 1,
				directus: '0.0.0',
				collections: [],
				fields: [],
				relations: [],
			};

			// Stop call to db later on in apply-diff
			vi.spyOn(getSchema, 'getSchema').mockReturnValue(Promise.resolve(snapshotApplyTestSchema));
			// We are not actually testing that deleteOne works, just that is is called correctly
			const deleteOneCollectionSpy = vi.spyOn(CollectionsService.prototype, 'deleteOne').mockResolvedValue('test');

			vi.mocked(getSnapshot).mockResolvedValue(snapshotBeforeDeleteCollection);

			const diff = await getTargetSnapshotDiff(snapshotToApply, {
				current: snapshotBeforeDeleteCollection,
				database: db,
			});

			await applyDiff(diff, { database: db, expectedHash: 'HASH' });

			expect(deleteOneCollectionSpy).toHaveBeenCalledTimes(3);
		});

		const definition = (collection: string, group: string | null, table = true): Collection => ({
			collection,
			meta: { collection, group } as CollectionMeta,
			schema: table ? ({ name: collection } as Collection['schema']) : null,
		});

		const snapshotOf = (collections: Collection[]): Snapshot => ({
			version: 1,
			directus: '0.0.0',
			collections,
			fields: [],
			relations: [],
		});

		const deletion = (lhs: Collection): DiffDeleted<Collection> => ({ kind: 'D', lhs });

		it('Deletes dropped collections whose group survives or that have no metadata row, children first', async () => {
			const imported: Collection = { ...definition('imported', null), meta: null };
			const archive = definition('archive', 'content');
			const entries = definition('entries', 'archive');

			const diff: SnapshotDiff = {
				collections: [
					{ collection: 'archive', diff: [deletion(archive)] },
					{ collection: 'entries', diff: [deletion(entries)] },
					{ collection: 'imported', diff: [deletion(imported)] },
				],
				fields: [],
				relations: [],
			};

			vi.spyOn(getSchema, 'getSchema').mockReturnValue(Promise.resolve(snapshotApplyTestSchema));
			const deleteOneCollectionSpy = vi.spyOn(CollectionsService.prototype, 'deleteOne').mockResolvedValue('test');

			vi.mocked(getSnapshot).mockResolvedValue(
				snapshotOf([definition('content', null, false), archive, entries, imported])
			);

			await applyDiff(diff, { database: db, expectedHash: 'HASH' });

			expect(deleteOneCollectionSpy.mock.calls.map(([collection]) => collection)).toEqual([
				'entries',
				'archive',
				'imported',
			]);
		});

		it.each([
			['schema', { name: 'articles' }],
			['meta', { collection: 'articles', group: null }],
		])('Refuses removing only the %s of a kept collection and deletes nothing', async (attribute, lhs) => {
			const removal: Diff<unknown> = { kind: 'D', path: [attribute], lhs };

			const diff: SnapshotDiff = {
				collections: [{ collection: 'articles', diff: [removal as Diff<Collection | undefined>] }],
				fields: [],
				relations: [],
			};

			vi.spyOn(getSchema, 'getSchema').mockReturnValue(Promise.resolve(snapshotApplyTestSchema));
			const deleteOneCollectionSpy = vi.spyOn(CollectionsService.prototype, 'deleteOne').mockResolvedValue('test');
			vi.mocked(getSnapshot).mockResolvedValue(snapshotOf([definition('articles', null)]));

			await expect(applyDiff(diff, { database: db, expectedHash: 'HASH' })).rejects.toBeInstanceOf(
				InvalidPayloadException
			);

			expect(deleteOneCollectionSpy).not.toHaveBeenCalled();
		});
	});

	describe('Drop a collection that a kept field references', () => {
		const keyField = (collection: string, field: string, related: string | null = null) => ({
			collection,
			field,
			type: 'integer',
			meta: null,
			schema: {
				name: field,
				table: collection,
				data_type: 'integer',
				is_primary_key: related === null && field === 'id',
				foreign_key_table: related,
				foreign_key_column: related === null ? null : 'id',
			},
		});

		const reference = (collection: string, field: string, related: string) => ({
			collection,
			field,
			related_collection: related,
			meta: null,
			schema: { table: collection, column: field, foreign_key_table: related, foreign_key_column: 'id' },
		});

		const snapshotFor = (owners: Record<string, Record<string, string | null>>, relations: unknown[]): Snapshot =>
			({
				version: 1,
				directus: '0.0.0',
				collections: Object.keys(owners).map((collection) => ({
					collection,
					meta: null,
					schema: { name: collection },
				})),
				fields: Object.entries(owners).flatMap(([collection, fields]) =>
					Object.entries(fields).map(([field, related]) => keyField(collection, field, related))
				),
				relations,
			} as unknown as Snapshot);

		const overviewFor = (owners: Record<string, Record<string, string | null>>, relations: unknown[]) =>
			({
				collections: Object.fromEntries(
					Object.entries(owners).map(([collection, fields]) => [
						collection,
						{
							collection,
							primary: 'id',
							singleton: false,
							sortField: null,
							note: null,
							accountability: 'all',
							fields: Object.fromEntries(Object.keys(fields).map((field) => [field, { field, type: 'integer' }])),
						},
					])
				),
				relations,
			} as unknown as Awaited<ReturnType<typeof getSchema.getSchema>>);

		async function applyDropping(
			owners: Record<string, Record<string, string | null>>,
			relations: ReturnType<typeof reference>[],
			dropped: string,
			removed: { collection: string; field: string }
		): Promise<void> {
			const current = snapshotFor(owners, relations);

			const desired: Snapshot = {
				...current,
				collections: current.collections.filter((entry) => entry.collection !== dropped),
				fields: current.fields.filter((entry) => entry.collection !== dropped),
				relations: current.relations.filter(
					(entry) =>
						entry.related_collection !== dropped &&
						!(entry.collection === removed.collection && entry.field === removed.field)
				),
			};

			vi.spyOn(getSchema, 'getSchema').mockReturnValue(Promise.resolve(overviewFor(owners, relations)));
			vi.mocked(getSnapshot).mockResolvedValue(current);

			const diff = await getTargetSnapshotDiff(desired, { current, database: db });
			await applyDiff(diff, { database: db, expectedHash: 'HASH' });
		}

		it('deletes the dropped relation once and still deletes an unrelated one', async () => {
			const deleteCollection = vi.spyOn(CollectionsService.prototype, 'deleteOne').mockResolvedValue('authors');
			const deleteRelation = vi.spyOn(RelationsService.prototype, 'deleteOne').mockResolvedValue();

			await applyDropping(
				{
					articles: { id: null, author: 'authors', editor: 'editors' },
					authors: { id: null },
					editors: { id: null },
				},
				[reference('articles', 'author', 'authors'), reference('articles', 'editor', 'editors')],
				'authors',
				{ collection: 'articles', field: 'editor' }
			);

			expect(deleteCollection.mock.calls.map(([collection]) => collection)).toEqual(['authors']);

			expect(deleteRelation.mock.calls.map(([collection, field]) => [collection, field])).toEqual([
				['articles', 'author'],
				['articles', 'editor'],
			]);
		});

		it('keeps a dropped relation apart from another whose names join to the same string', async () => {
			vi.spyOn(CollectionsService.prototype, 'deleteOne').mockResolvedValue('x');
			const deleteRelation = vi.spyOn(RelationsService.prototype, 'deleteOne').mockResolvedValue();

			await applyDropping(
				{
					'a.b': { id: null, c: 'x' },
					a: { id: null, 'b.c': 'y' },
					x: { id: null },
					y: { id: null },
				},
				[reference('a.b', 'c', 'x'), reference('a', 'b.c', 'y')],
				'x',
				{ collection: 'a', field: 'b.c' }
			);

			expect(deleteRelation.mock.calls.map(([collection, field]) => [collection, field])).toEqual([
				['a.b', 'c'],
				['a', 'b.c'],
			]);
		});

		it('fails the run without deleting the collection when its relation cleanup fails', async () => {
			const deleteCollection = vi.spyOn(CollectionsService.prototype, 'deleteOne').mockResolvedValue('authors');

			const deleteRelation = vi
				.spyOn(RelationsService.prototype, 'deleteOne')
				.mockRejectedValue(new Error('relation cleanup failed'));

			await expect(
				applyDropping(
					{ articles: { id: null, author: 'authors' }, authors: { id: null } },
					[reference('articles', 'author', 'authors')],
					'authors',
					{ collection: 'articles', field: 'author' }
				)
			).rejects.toThrow();

			expect(deleteRelation).toHaveBeenCalledTimes(1);
			expect(deleteCollection).not.toHaveBeenCalled();
		});
	});
});
