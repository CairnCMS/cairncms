import type { Diff } from 'deep-diff';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaApplyFailedException } from '../exceptions/schema-apply-failed.js';
import { SchemaPostCommitFailedException } from '../exceptions/schema-post-commit-failed.js';
import { SchemaStateChangedException } from '../exceptions/schema-state-changed.js';
import type { Collection, MutationOptions, Snapshot, SnapshotDiff, SnapshotField } from '../types/index.js';

const order: string[] = [];
const collections = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() };
const fields = { createField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn() };
const relations = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() };
const cache = { flushCaches: vi.fn(async () => void order.push('flush')), clearSystemCache: vi.fn() };
const emitter = { emitAction: vi.fn(), emitActionAndWait: vi.fn(async () => undefined) };
let folderRows: { id: string; key: string }[] = [];
let currentSnapshotValue: Snapshot;
let currentSchemaValue: any;
let currentVendor = 'postgres';
let commitRejection: unknown = null;
let observedTables = new Set<string>();
let observedColumns = new Set<string>();
let observedMetaRows: Record<string, Record<string, string>[]> = {};
let observedReadThrows = false;

const schemaHelper = {
	preColumnChange: vi.fn(async (): Promise<boolean> => false),
	postColumnChange: vi.fn(async (): Promise<void> => undefined),
};

const relationSchema = () => ({
	collections: {
		articles: { collection: 'articles', primary: 'id', fields: { id: {}, author: {} } },
		authors: { collection: 'authors', primary: 'id', fields: { id: {} } },
	},
	relations: [],
});

function folderQueryBuilder() {
	const rows = folderRows;

	return {
		where: (column: string, value: unknown) => ({
			first: async () => rows.find((row: Record<string, unknown>) => row[column] === value),
		}),
		then: (resolve: (value: typeof folderRows) => unknown, reject: (reason: unknown) => unknown) =>
			Promise.resolve(rows).then(resolve, reject),
	};
}

function folderTrx() {
	return { select: () => ({ from: () => folderQueryBuilder() }) };
}

vi.mock('../database/index.js', () => {
	const makeDatabase = () => {
		const database: any = (table: string) => ({
			where: (where: Record<string, string>) => ({
				first: async () =>
					(observedMetaRows[table] ?? []).find((row) =>
						Object.entries(where).every(([key, value]) => row[key] === value)
					),
			}),
		});

		database.transaction = async (cb: any) => {
			await cb(folderTrx());
			order.push('commit');
			if (commitRejection) throw commitRejection;
		};

		database.schema = {
			hasTable: async (table: string) => {
				if (observedReadThrows) throw new Error('inspection unavailable');
				return observedTables.has(table);
			},
			hasColumn: async (table: string, column: string) => observedColumns.has(`${table}.${column}`),
		};

		return database;
	};

	return { default: () => makeDatabase(), getDatabaseClient: () => currentVendor };
});

vi.mock('../database/bound-transaction.js', () => ({
	runInBoundSerializable: async (database: any, fn: any, flush: any) => {
		const result = await database.transaction(fn);
		await flush({ events: [], responseCacheDirty: false, systemCacheDirty: false });
		return result;
	},
}));

vi.mock('./get-schema.js', () => ({ getSchema: async () => currentSchemaValue }));
vi.mock('./get-snapshot.js', () => ({ getSnapshot: async () => currentSnapshotValue }));
vi.mock('./get-versioned-hash.js', () => ({ getVersionedHash: () => 'HASH' }));

vi.mock('../database/helpers/index.js', () => ({
	getHelpers: () => ({ schema: schemaHelper }),
}));

vi.mock('../services/collections.js', () => ({
	CollectionsService: vi.fn(function () {
		return collections;
	}),
}));

vi.mock('../services/fields.js', () => ({
	FieldsService: vi.fn(function () {
		return fields;
	}),
}));

vi.mock('../services/relations.js', () => ({
	RelationsService: vi.fn(function () {
		return relations;
	}),
}));

vi.mock('../emitter.js', () => ({ default: emitter }));
vi.mock('../cache.js', () => cache);
vi.mock('../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn() } }));

const { applyDiff } = await import('./apply-diff.js');
const { getTargetSnapshotDiff } = await import('./get-target-snapshot-diff.js');

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	if (overrides.version === 2) {
		return { release: '10.0.0', collections: [], fields: [], relations: [], ...overrides } as unknown as Snapshot;
	}

	return { version: 1, directus: '10.0.0', collections: [], fields: [], relations: [], ...overrides };
}

function stubCollection(collection: string, meta: Record<string, unknown> = {}): Collection {
	return { collection, meta, schema: { name: collection } } as unknown as Collection;
}

function collectionDiff(collection: string, diff: Diff<Collection | undefined>[]) {
	return { collection, diff };
}

const emptyDiff = (): SnapshotDiff => ({ collections: [], fields: [], relations: [] });

function newRelationDiff(rhs: Record<string, unknown>): SnapshotDiff {
	const diff = emptyDiff();

	diff.relations = [
		{ collection: 'articles', field: 'author', related_collection: 'authors', diff: [{ kind: 'N', rhs } as any] },
	];

	return diff;
}

const HASH = 'HASH';

beforeEach(() => {
	currentSnapshotValue = snapshot();
	currentSchemaValue = { collections: {}, relations: [] };
	currentVendor = 'postgres';
	commitRejection = null;
	observedTables = new Set();
	observedColumns = new Set();
	observedMetaRows = {};
	observedReadThrows = false;
	schemaHelper.preColumnChange.mockResolvedValue(false);
	schemaHelper.postColumnChange.mockResolvedValue(undefined);
});

describe('applyDiff in-transaction recheck', () => {
	beforeEach(() => vi.clearAllMocks());

	it('refuses with SchemaStateChangedException and writes nothing when the expected hash no longer matches', async () => {
		const diff = emptyDiff();
		diff.collections = [collectionDiff('fresh', [{ kind: 'N', rhs: stubCollection('fresh') } as any])];

		await expect(applyDiff(diff, { expectedHash: 'STALE' })).rejects.toBeInstanceOf(SchemaStateChangedException);

		expect(collections.createOne).not.toHaveBeenCalled();
	});
});

describe('applyDiff collection routing', () => {
	beforeEach(() => vi.clearAllMocks());

	it('routes a nested collection-meta delete to updateOne, never deleteOne', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('articles', { note: 'x' })] });

		const diff = emptyDiff();
		diff.collections = [collectionDiff('articles', [{ kind: 'D', path: ['meta', 'note'], lhs: 'x' } as any])];

		await applyDiff(diff, { expectedHash: HASH });

		expect(collections.updateOne).toHaveBeenCalledWith('articles', expect.anything(), expect.anything());
		expect(collections.deleteOne).not.toHaveBeenCalled();
	});

	it('routes a nested collection-meta create to updateOne, never createOne', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('articles')] });
		const diff = emptyDiff();
		diff.collections = [collectionDiff('articles', [{ kind: 'N', path: ['meta', 'icon'], rhs: 'box' } as any])];

		await applyDiff(diff, { expectedHash: HASH });

		expect(collections.updateOne).toHaveBeenCalledWith('articles', expect.anything(), expect.anything());
		expect(collections.createOne).not.toHaveBeenCalled();
	});

	it('still deletes a genuine whole-collection delete (no path)', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('temp', { group: null })] });

		const diff = emptyDiff();

		diff.collections = [
			collectionDiff('temp', [{ kind: 'D', lhs: { collection: 'temp', meta: { group: null } } } as any]),
		];

		await applyDiff(diff, { expectedHash: HASH });

		expect(collections.deleteOne).toHaveBeenCalledWith('temp', expect.anything());
	});

	it('still creates a genuine whole-collection create (no path)', async () => {
		const diff = emptyDiff();

		diff.collections = [
			collectionDiff('fresh', [
				{ kind: 'N', rhs: { collection: 'fresh', meta: { group: null }, schema: { name: 'fresh' } } } as any,
			]),
		];

		await applyDiff(diff, { expectedHash: HASH });

		expect(collections.createOne).toHaveBeenCalledWith(
			expect.objectContaining({ collection: 'fresh' }),
			expect.anything()
		);
	});

	it('creates a new grouped child even when its existing parent only has a nested-meta change', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('parent', { group: null })] });

		const diff = emptyDiff();

		diff.collections = [
			collectionDiff('parent', [{ kind: 'N', path: ['meta', 'icon'], rhs: 'box' } as any]),
			collectionDiff('child', [
				{ kind: 'N', rhs: { collection: 'child', meta: { group: 'parent' }, schema: { name: 'child' } } } as any,
			]),
		];

		await applyDiff(diff, { expectedHash: HASH });

		expect(collections.createOne).toHaveBeenCalledWith(
			expect.objectContaining({ collection: 'child' }),
			expect.anything()
		);
	});
});

describe('applyDiff field and relation routing', () => {
	const legacy = {
		collection: 'articles',
		field: 'legacy',
		type: 'integer',
		meta: null,
		schema: { name: 'legacy', table: 'articles', data_type: 'integer' },
	};

	const author = {
		collection: 'articles',
		field: 'author',
		related_collection: 'authors',
		meta: { many_collection: 'articles', many_field: 'author', one_collection: 'authors', sort_field: 'position' },
		schema: { table: 'articles', column: 'author', foreign_key_table: 'authors', foreign_key_column: 'id' },
	};

	beforeEach(() => {
		vi.clearAllMocks();

		currentSnapshotValue = snapshot({
			collections: [stubCollection('articles'), stubCollection('authors')],
			fields: [legacy as unknown as SnapshotField],
			relations: [author as any],
		});

		currentSchemaValue = { ...relationSchema(), relations: [author] };
	});

	const attributeRemovals = (): SnapshotDiff => {
		const diff = emptyDiff();

		diff.fields = [
			{ collection: 'articles', field: 'legacy', diff: [{ kind: 'D', path: ['meta'], lhs: null } as any] },
		];

		diff.relations = [
			{
				collection: 'articles',
				field: 'author',
				related_collection: 'authors',
				diff: [{ kind: 'D', path: ['meta', 'sort_field'], lhs: 'position' } as any],
			},
		];

		return diff;
	};

	it('updates a field whose diff removes only its null meta, and a relation whose diff omits a metadata property', async () => {
		await applyDiff(attributeRemovals(), { expectedHash: HASH });

		expect(fields.deleteField).not.toHaveBeenCalled();
		expect(fields.createField).not.toHaveBeenCalled();
		expect(fields.updateField).toHaveBeenCalledOnce();

		const [, writtenField] = fields.updateField.mock.calls[0]!;
		expect(writtenField).toEqual({ collection: 'articles', field: 'legacy', type: 'integer', schema: legacy.schema });

		expect(relations.deleteOne).not.toHaveBeenCalled();
		expect(relations.updateOne).toHaveBeenCalledOnce();

		const [collection, field, writtenRelation] = relations.updateOne.mock.calls[0]!;
		expect([collection, field]).toEqual(['articles', 'author']);

		expect(writtenRelation.meta).toEqual({
			many_collection: 'articles',
			many_field: 'author',
			one_collection: 'authors',
		});

		expect(writtenRelation.schema).toEqual(author.schema);
	});

	it('reports both changes as updates when the apply fails', async () => {
		currentVendor = 'mysql';
		relations.updateOne.mockRejectedValueOnce(new Error('alter table failed'));

		const error = await applyDiff(attributeRemovals(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaApplyFailedException);

		expect(error.extensions.persisted.fields).toEqual([
			expect.objectContaining({ collection: 'articles', field: 'legacy', operation: 'update' }),
		]);

		expect(error.extensions.persisted.relations).toEqual([
			expect.objectContaining({ collection: 'articles', field: 'author', operation: 'update' }),
		]);
	});
});

describe('applyDiff relation creation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentSchemaValue = relationSchema();
	});

	it('creates a relation from the entry identifiers when the new value omits them', async () => {
		await applyDiff(newRelationDiff({ related_collection: 'authors', meta: null, schema: null }), {
			expectedHash: HASH,
		});

		expect(relations.createOne).toHaveBeenCalledWith(
			expect.objectContaining({ collection: 'articles', field: 'author', related_collection: 'authors' }),
			expect.anything()
		);
	});

	it('prefers the entry identifiers over conflicting identifiers in the new value', async () => {
		await applyDiff(
			newRelationDiff({ collection: 'other', field: 'other_field', related_collection: 'authors', meta: null }),
			{ expectedHash: HASH }
		);

		expect(relations.createOne).toHaveBeenCalledWith(
			expect.objectContaining({ collection: 'articles', field: 'author' }),
			expect.anything()
		);
	});
});

describe('applyDiff cache invalidation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		order.length = 0;
		currentSchemaValue = relationSchema();

		relations.createOne.mockImplementationOnce(async (_payload: unknown, opts: MutationOptions) => {
			opts.bypassEmitAction!({ event: 'relations.create', meta: {}, context: {} } as any);
		});
	});

	const diffWithActionEvent = () => newRelationDiff({ related_collection: 'authors', meta: null, schema: null });

	it('flushes every cache once after the schema transaction commits', async () => {
		await applyDiff(diffWithActionEvent(), { expectedHash: HASH });

		expect(cache.flushCaches).toHaveBeenCalledOnce();
		expect(cache.flushCaches).toHaveBeenCalledWith(true);
		expect(cache.clearSystemCache).not.toHaveBeenCalled();
		expect(order).toEqual(['commit', 'flush']);
		expect(emitter.emitActionAndWait).toHaveBeenCalledOnce();
	});
});

describe('applyDiff post-commit failure reporting', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		order.length = 0;
		currentSchemaValue = relationSchema();

		relations.createOne.mockImplementationOnce(async (_payload: unknown, opts: MutationOptions) => {
			opts.bypassEmitAction!({ event: 'relations.create', meta: {}, context: {} } as any);
		});
	});

	const diffWithActionEvent = () => newRelationDiff({ related_collection: 'authors', meta: null, schema: null });

	it('reports a committed cache failure and still delivers the action events', async () => {
		cache.flushCaches.mockRejectedValueOnce(new Error('cache unavailable'));

		const error = await applyDiff(diffWithActionEvent(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaPostCommitFailedException);
		expect(error.extensions).toMatchObject({ committed: true, phase: 'cache' });
		expect(emitter.emitActionAndWait).toHaveBeenCalledOnce();
	});

	it('reports a committed action failure', async () => {
		emitter.emitActionAndWait.mockRejectedValueOnce(new Error('listener exploded'));

		const error = await applyDiff(diffWithActionEvent(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaPostCommitFailedException);
		expect(error.extensions).toMatchObject({ committed: true, phase: 'actions' });
	});

	it('reports a committed foreign key restore failure, attempts the cache clear, and suppresses actions', async () => {
		schemaHelper.preColumnChange.mockResolvedValueOnce(true);
		schemaHelper.postColumnChange.mockRejectedValueOnce(new Error('pragma failed'));

		const error = await applyDiff(diffWithActionEvent(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaPostCommitFailedException);
		expect(error.extensions).toMatchObject({ committed: true, phase: 'foreign_keys' });
		expect(cache.flushCaches).toHaveBeenCalledWith(true);
		expect(emitter.emitActionAndWait).not.toHaveBeenCalled();
	});

	it('reports a combined foreign key restore and cache failure', async () => {
		schemaHelper.preColumnChange.mockResolvedValueOnce(true);
		schemaHelper.postColumnChange.mockRejectedValueOnce(new Error('pragma failed'));
		cache.flushCaches.mockRejectedValueOnce(new Error('cache unavailable'));

		const error = await applyDiff(diffWithActionEvent(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaPostCommitFailedException);
		expect(error.extensions).toMatchObject({ committed: true, phase: 'foreign_keys_and_cache' });
		expect(emitter.emitActionAndWait).not.toHaveBeenCalled();
	});
});

describe('applyDiff failed-apply persistence classification', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		order.length = 0;
		currentSchemaValue = relationSchema();
	});

	const failingCollectionCreate = () => {
		const diff = emptyDiff();
		diff.collections = [collectionDiff('fresh', [{ kind: 'N', rhs: stubCollection('fresh') } as any])];
		return diff;
	};

	it('propagates the original error when a PostgreSQL failure left nothing applied', async () => {
		const failure = new Error('column already exists');
		collections.createOne.mockRejectedValueOnce(failure);

		await expect(applyDiff(failingCollectionCreate(), { expectedHash: HASH })).rejects.toBe(failure);
		expect(cache.flushCaches).not.toHaveBeenCalled();
	});

	it('reports a carrier when a PostgreSQL failure left a created table behind', async () => {
		const failure = new Error('a later step failed');
		collections.createOne.mockRejectedValueOnce(failure);
		observedTables = new Set(['fresh']);

		const error = await applyDiff(failingCollectionCreate(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaApplyFailedException);
		expect(error.cause).toBe(failure);
		expect(cache.flushCaches).toHaveBeenCalledWith(true);
	});

	it('reports a persisted-outcome carrier that retains the original cause on a MySQL mid-apply failure', async () => {
		currentVendor = 'mysql';
		const failure = new Error('alter table failed');
		collections.createOne.mockRejectedValueOnce(failure);
		observedTables = new Set(['fresh']);

		const error = await applyDiff(failingCollectionCreate(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaApplyFailedException);
		expect(error.cause).toBe(failure);
		expect(Object.keys(error.extensions)).toEqual(['persisted']);
	});

	it('reports an unknown outcome when the post-failure inspection fails', async () => {
		const failure = new Error('mid-apply failure');
		collections.createOne.mockRejectedValueOnce(failure);
		observedReadThrows = true;

		const error = await applyDiff(failingCollectionCreate(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaApplyFailedException);
		expect(error.extensions).toMatchObject({ persisted: 'unknown' });
	});

	it('reports foreign keys unrestored when restoration fails on the failure path', async () => {
		schemaHelper.preColumnChange.mockResolvedValueOnce(true);
		schemaHelper.postColumnChange.mockRejectedValueOnce(new Error('pragma failed'));
		currentVendor = 'sqlite';
		const failure = new Error('mid-apply failure');
		collections.createOne.mockRejectedValueOnce(failure);

		const error = await applyDiff(failingCollectionCreate(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaApplyFailedException);
		expect(error.extensions).toMatchObject({ foreignKeysRestored: false });
	});

	it('reports an unresolved outcome for an update-only apply whose commit is unacknowledged', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('articles', { note: 'x' })] });
		commitRejection = new Error('connection reset during commit');

		const diff = emptyDiff();
		diff.collections = [collectionDiff('articles', [{ kind: 'D', path: ['meta', 'note'], lhs: 'x' } as any])];

		const error = await applyDiff(diff, { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaApplyFailedException);
		expect(error.extensions.persisted).not.toBe('unknown');
		expect(error.extensions.persisted.collections[0]).toMatchObject({ operation: 'update', table: 'unknown' });
		expect(cache.flushCaches).toHaveBeenCalledWith(true);
	});

	it('classifies a schema-null physical field creation by its type, not its schema object', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('articles')] });
		observedTables = new Set(['articles']);
		observedColumns = new Set(['articles.headline']);

		const failure = new Error('a later step failed');
		fields.createField.mockRejectedValueOnce(failure);

		const diff = emptyDiff();

		diff.fields = [
			{
				collection: 'articles',
				field: 'headline',
				diff: [
					{ kind: 'N', rhs: { field: 'headline', type: 'string', schema: null, meta: { interface: 'input' } } } as any,
				],
			},
		];

		const error = await applyDiff(diff, { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaApplyFailedException);
		const reported = error.extensions.persisted.fields.find((entry: any) => entry.field === 'headline');
		expect(reported.column).toBe('applied');
	});

	it('treats a rolled-back deletion of a database-only field as a clean rollback', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('articles')] });
		observedTables = new Set(['articles']);
		observedColumns = new Set(['articles.legacy']);

		const failure = new Error('mid-apply failure');
		fields.deleteField.mockRejectedValueOnce(failure);

		const diff = emptyDiff();

		diff.fields = [
			{
				collection: 'articles',
				field: 'legacy',
				diff: [{ kind: 'D', lhs: { field: 'legacy', type: 'string', schema: { name: 'legacy' }, meta: null } } as any],
			},
		];

		await expect(applyDiff(diff, { expectedHash: HASH })).rejects.toBe(failure);
	});

	it('treats an unknown-type field column as not_applicable, matching the column builder skip', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('articles')] });
		currentVendor = 'mysql';
		fields.createField.mockRejectedValueOnce(new Error('mid-apply failure'));

		const diff = emptyDiff();

		diff.fields = [
			{
				collection: 'articles',
				field: 'mystery',
				diff: [
					{ kind: 'N', rhs: { field: 'mystery', type: 'unknown', schema: null, meta: { interface: 'input' } } } as any,
				],
			},
		];

		const error = await applyDiff(diff, { expectedHash: HASH }).catch((err) => err);

		const reported = error.extensions.persisted.fields.find((entry: any) => entry.field === 'mystery');
		expect(reported.column).toBe('not_applicable');
	});

	it('keeps metadata unknown for a meta-null field creation that the service may still normalize', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('articles')] });
		currentVendor = 'mysql';
		fields.createField.mockRejectedValueOnce(new Error('mid-apply failure'));

		const diff = emptyDiff();

		diff.fields = [
			{
				collection: 'articles',
				field: 'stamp',
				diff: [{ kind: 'N', rhs: { field: 'stamp', type: 'timestamp', schema: null, meta: null } } as any],
			},
		];

		const error = await applyDiff(diff, { expectedHash: HASH }).catch((err) => err);

		const reported = error.extensions.persisted.fields.find((entry: any) => entry.field === 'stamp');
		expect(reported.metadata).toBe('unknown');
	});

	it('reports a native relation deletion metadata as not_applicable', async () => {
		currentVendor = 'mysql';

		currentSchemaValue = {
			collections: {
				articles: { collection: 'articles', primary: 'id', fields: { id: {}, author: {} } },
				authors: { collection: 'authors', primary: 'id', fields: { id: {} } },
			},
			relations: [{ collection: 'articles', field: 'author', related_collection: 'authors', meta: null, schema: {} }],
		};

		relations.deleteOne.mockRejectedValueOnce(new Error('mid-apply failure'));

		const diff = emptyDiff();

		diff.relations = [
			{
				collection: 'articles',
				field: 'author',
				related_collection: 'authors',
				diff: [
					{
						kind: 'D',
						lhs: { collection: 'articles', field: 'author', related_collection: 'authors', meta: null, schema: {} },
					} as any,
				],
			},
		];

		const error = await applyDiff(diff, { expectedHash: HASH }).catch((err) => err);

		const reported = error.extensions.persisted.relations.find((entry: any) => entry.field === 'author');
		expect(reported.metadata).toBe('not_applicable');
		expect(reported.foreignKey).toBe('unknown');
	});

	const nativeColumnDelete = () => {
		const diff = emptyDiff();

		diff.fields = [
			{
				collection: 'articles',
				field: 'native',
				diff: [{ kind: 'D', lhs: { field: 'native', type: 'unknown', schema: { name: 'native' }, meta: null } } as any],
			},
		];

		return diff;
	};

	it('reports a lost-acknowledgement deletion of a native unknown column as applied', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('articles')] });
		currentVendor = 'mysql';
		observedTables = new Set(['articles']);

		const commitError = new Error('connection reset during commit');
		commitRejection = commitError;

		const error = await applyDiff(nativeColumnDelete(), { expectedHash: HASH }).catch((err) => err);

		expect(error).toBeInstanceOf(SchemaApplyFailedException);
		expect(error.cause).toBe(commitError);
		const reported = error.extensions.persisted.fields.find((entry: any) => entry.field === 'native');
		expect(reported.column).toBe('applied');
		expect(cache.flushCaches).toHaveBeenCalledWith(true);
	});

	it('treats a rolled-back deletion of a native unknown column as a clean rollback', async () => {
		currentSnapshotValue = snapshot({ collections: [stubCollection('articles')] });
		observedTables = new Set(['articles']);
		observedColumns = new Set(['articles.native']);

		const failure = new Error('mid-apply failure');
		fields.deleteField.mockRejectedValueOnce(failure);

		await expect(applyDiff(nativeColumnDelete(), { expectedHash: HASH })).rejects.toBe(failure);
	});
});

describe('applyDiff folder references', () => {
	const IMAGES_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
	const OTHER_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

	beforeEach(() => {
		vi.clearAllMocks();
		folderRows = [{ id: IMAGES_ID, key: 'images' }];
	});

	function field(collection: string, name: string, meta: Record<string, unknown>): SnapshotField {
		return { collection, field: name, type: 'uuid', schema: null, meta: { collection, field: name, ...meta } } as any;
	}

	function fieldDiff(collection: string, name: string, diff: Diff<any>[]) {
		return { collection, field: name, diff };
	}

	it('writes the target folder ID for a field of a new collection', async () => {
		const diff = emptyDiff();
		diff.collections = [collectionDiff('articles', [{ kind: 'N', rhs: stubCollection('articles') } as any])];

		diff.fields = [
			fieldDiff('articles', 'image', [
				{ kind: 'N', rhs: field('articles', 'image', { interface: 'file', options: { folder: 'images' } }) },
			]),
		];

		await applyDiff(diff, { expectedHash: HASH });

		const payload = collections.createOne.mock.calls[0]![0] as { fields: SnapshotField[] };
		expect(payload.fields[0]!.meta.options).toEqual({ folder: IMAGES_ID });
	});

	it('writes the target folder ID for a new field on an existing collection', async () => {
		const diff = emptyDiff();

		diff.fields = [
			fieldDiff('articles', 'image', [
				{ kind: 'N', rhs: field('articles', 'image', { interface: 'file', options: { folder: 'images' } }) },
			]),
		];

		await applyDiff(diff, { expectedHash: HASH });

		expect((fields.createField.mock.calls[0]![1] as SnapshotField).meta.options).toEqual({ folder: IMAGES_ID });
	});

	it('writes the target folder ID for an updated field, rebuilt from the stored field', async () => {
		currentSnapshotValue = snapshot({
			fields: [field('articles', 'image', { interface: 'file', note: null, options: { folder: OTHER_ID } })],
		});

		const diff = emptyDiff();

		diff.fields = [
			fieldDiff('articles', 'image', [
				{ kind: 'E', path: ['meta', 'options', 'folder'], lhs: OTHER_ID, rhs: 'images' },
				{ kind: 'E', path: ['meta', 'note'], lhs: null, rhs: 'Hero image' },
			]),
		];

		await applyDiff(diff, { expectedHash: HASH });

		const written = fields.updateField.mock.calls[0]![1] as SnapshotField;
		expect(written.meta.options).toEqual({ folder: IMAGES_ID });
		expect(written.meta.note).toBe('Hero image');
	});

	it('writes version 1 IDs as given and keeps unchanged IDs', async () => {
		currentSnapshotValue = snapshot({
			fields: [
				field('articles', 'image', { interface: 'file', options: { folder: IMAGES_ID } }),
				field('articles', 'cover', { interface: 'file', note: null, options: { folder: IMAGES_ID } }),
			],
		});

		const diff = emptyDiff();

		diff.fields = [
			fieldDiff('articles', 'image', [
				{ kind: 'E', path: ['meta', 'options', 'folder'], lhs: IMAGES_ID, rhs: OTHER_ID },
			]),
			fieldDiff('articles', 'cover', [{ kind: 'E', path: ['meta', 'note'], lhs: null, rhs: 'Cover' }]),
		];

		await applyDiff(diff, { expectedHash: HASH });

		const written = fields.updateField.mock.calls.map(([, values]) => (values as SnapshotField).meta.options);
		expect(written).toEqual([{ folder: OTHER_ID }, { folder: IMAGES_ID }]);
	});

	it('keeps the stored ID when a version 1 diff moves a field to an extension interface', async () => {
		currentSnapshotValue = snapshot({
			fields: [
				field('articles', 'body', { interface: 'input-rich-text-md', options: { folder: IMAGES_ID } }),
				field('articles', 'items', {
					interface: 'list',
					options: {
						fields: [{ field: 'text', meta: { interface: 'input-rich-text-md', options: { folder: IMAGES_ID } } }],
					},
				}),
			],
		});

		const diff = emptyDiff();

		diff.fields = [
			fieldDiff('articles', 'body', [
				{ kind: 'E', path: ['meta', 'interface'], lhs: 'input-rich-text-md', rhs: 'custom-md' },
			]),
			fieldDiff('articles', 'items', [
				{
					kind: 'E',
					path: ['meta', 'options', 'fields', 0, 'meta', 'interface'],
					lhs: 'input-rich-text-md',
					rhs: 'custom-md',
				},
			]),
		];

		await applyDiff(diff, { expectedHash: HASH });

		const [body, items] = fields.updateField.mock.calls.map(([, values]) => values as SnapshotField);
		expect(body!.meta).toMatchObject({ interface: 'custom-md', options: { folder: IMAGES_ID } });

		expect((items!.meta.options as any).fields[0].meta).toEqual({
			interface: 'custom-md',
			options: { folder: IMAGES_ID },
		});
	});

	it('resolves the key when a version 2 diff moves a field from an extension interface to a registered one', async () => {
		currentSnapshotValue = snapshot({
			fields: [field('articles', 'body', { interface: 'custom-md', options: { folder: OTHER_ID } })],
		});

		const diff = emptyDiff();

		diff.fields = [
			fieldDiff('articles', 'body', [
				{ kind: 'E', path: ['meta', 'interface'], lhs: 'custom-md', rhs: 'input-rich-text-md' },
				{ kind: 'E', path: ['meta', 'options', 'folder'], lhs: OTHER_ID, rhs: 'images' },
			]),
		];

		await applyDiff(diff, { expectedHash: HASH });

		expect((fields.updateField.mock.calls[0]![1] as SnapshotField).meta.options).toEqual({ folder: IMAGES_ID });
	});

	it('refuses a missing folder key before any write', async () => {
		const diff = emptyDiff();
		diff.collections = [collectionDiff('logs', [{ kind: 'N', rhs: stubCollection('logs') } as any])];

		diff.fields = [
			fieldDiff('articles', 'image', [
				{ kind: 'N', rhs: field('articles', 'image', { interface: 'file', options: { folder: 'missing' } }) },
			]),
		];

		await expect(applyDiff(diff, { expectedHash: HASH })).rejects.toThrow(
			'Folder reference "missing" could not be resolved. Referenced by: articles.image.meta.options.folder'
		);

		expect(collections.createOne).not.toHaveBeenCalled();
		expect(fields.createField).not.toHaveBeenCalled();
	});

	describe('from a version 2 diff', () => {
		const database = folderTrx() as any;

		async function diffAndApply(current: Snapshot, desired: Snapshot) {
			currentSnapshotValue = current;
			await applyDiff(await getTargetSnapshotDiff(desired, { current, database }), { expectedHash: HASH });
		}

		it('writes a literal value when a field leaves the registry for an extension interface', async () => {
			const current = snapshot({
				fields: [field('articles', 'body', { interface: 'input-rich-text-md', options: { folder: IMAGES_ID } })],
			});

			const desired = snapshot({
				version: 2,
				fields: [field('articles', 'body', { interface: 'custom-md', options: { folder: 'images' } })],
			});

			await diffAndApply(current, desired);

			expect((fields.updateField.mock.calls[0]![1] as SnapshotField).meta).toMatchObject({
				interface: 'custom-md',
				options: { folder: 'images' },
			});
		});

		it('writes a literal value when a repeater sub-field leaves the registry', async () => {
			const subField = (meta: Record<string, unknown>) => ({ field: 'text', meta });

			const current = snapshot({
				fields: [
					field('articles', 'items', {
						interface: 'list',
						options: { fields: [subField({ interface: 'input-rich-text-md', options: { folder: IMAGES_ID } })] },
					}),
				],
			});

			const desired = snapshot({
				version: 2,
				fields: [
					field('articles', 'items', {
						interface: 'list',
						options: { fields: [subField({ interface: 'custom-md', options: { folder: 'images' } })] },
					}),
				],
			});

			await diffAndApply(current, desired);

			const written = fields.updateField.mock.calls[0]![1] as SnapshotField;

			expect((written.meta.options as any).fields[0].meta).toEqual({
				interface: 'custom-md',
				options: { folder: 'images' },
			});
		});

		it('writes nothing when a registered folder already matches its key', async () => {
			const current = snapshot({
				fields: [field('articles', 'image', { interface: 'file', options: { folder: IMAGES_ID } })],
			});

			const desired = snapshot({
				version: 2,
				fields: [field('articles', 'image', { interface: 'file', options: { folder: 'images' } })],
			});

			await diffAndApply(current, desired);

			expect(fields.updateField).not.toHaveBeenCalled();
		});

		it.each([
			['cleared', { folder: null }, { kind: 'E', lhs: 'images', rhs: null }],
			['removed', {}, { kind: 'D', lhs: 'images' }],
		])('shows the key when a registered folder is %s, and writes the result', async (_label, options, entry) => {
			const current = snapshot({
				fields: [field('articles', 'image', { interface: 'file', options: { folder: IMAGES_ID } })],
			});

			const desired = snapshot({ version: 2, fields: [field('articles', 'image', { interface: 'file', options })] });
			const diff = await getTargetSnapshotDiff(desired, { current, database });

			expect(diff.fields[0]!.diff).toEqual([{ ...entry, path: ['meta', 'options', 'folder'] }]);

			currentSnapshotValue = current;
			await applyDiff(diff, { expectedHash: HASH });

			expect((fields.updateField.mock.calls[0]![1] as SnapshotField).meta.options).toEqual(options);
		});
	});
});
