import type { Diff } from 'deep-diff';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaStateChangedException } from '../exceptions/schema-state-changed.js';
import type { Collection, MutationOptions, Snapshot, SnapshotDiff, SnapshotField } from '../types/index.js';

const order: string[] = [];
const collections = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() };
const fields = { createField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn() };
const relations = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() };
const cache = { flushCaches: vi.fn(async () => void order.push('flush')), clearSystemCache: vi.fn() };
const emitter = { emitAction: vi.fn() };
let folderRows: { id: string; key: string }[] = [];
let currentSnapshotValue: Snapshot;
let currentSchemaValue: any;

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

vi.mock('../database/index.js', () => ({
	default: () => ({
		transaction: async (cb: any) => {
			await cb(folderTrx());
			order.push('commit');
		},
	}),
	getDatabaseClient: () => 'postgres',
}));

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
	getHelpers: () => ({ schema: { preColumnChange: async () => false, postColumnChange: async () => undefined } }),
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
		expect(emitter.emitAction).toHaveBeenCalledOnce();
	});

	it('rejects with the flush error and emits no action events when the flush fails after commit', async () => {
		const failure = new Error('cache unavailable');
		cache.flushCaches.mockRejectedValueOnce(failure);

		await expect(applyDiff(diffWithActionEvent(), { expectedHash: HASH })).rejects.toBe(failure);

		expect(order).toEqual(['commit']);
		expect(emitter.emitAction).not.toHaveBeenCalled();
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
