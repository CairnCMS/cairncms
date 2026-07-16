import type { Diff } from 'deep-diff';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection, Snapshot, SnapshotDiff } from '../types/index.js';

const collections = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() };
const fields = { createField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn() };
const relations = { createOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() };

vi.mock('../database/index.js', () => ({ default: () => ({ transaction: async (cb: any) => cb({}) }) }));
vi.mock('./get-schema.js', () => ({ getSchema: async () => ({ collections: {}, relations: [] }) }));

vi.mock('../database/helpers/index.js', () => ({
	getHelpers: () => ({ schema: { preColumnChange: async () => false, postColumnChange: async () => undefined } }),
}));

vi.mock('../services/collections.js', () => ({ CollectionsService: vi.fn(() => collections) }));
vi.mock('../services/fields.js', () => ({ FieldsService: vi.fn(() => fields) }));
vi.mock('../services/relations.js', () => ({ RelationsService: vi.fn(() => relations) }));
vi.mock('../emitter.js', () => ({ default: { emitAction: vi.fn() } }));
vi.mock('../cache.js', () => ({ clearSystemCache: vi.fn() }));
vi.mock('../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn() } }));

const { applyDiff } = await import('./apply-diff.js');

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return { version: 1, directus: '10.0.0', collections: [], fields: [], relations: [], ...overrides };
}

function stubCollection(collection: string, meta: Record<string, unknown> = {}): Collection {
	return { collection, meta, schema: { name: collection } } as unknown as Collection;
}

function collectionDiff(collection: string, diff: Diff<Collection | undefined>[]) {
	return { collection, diff };
}

const emptyDiff = (): SnapshotDiff => ({ collections: [], fields: [], relations: [] });

describe('applyDiff collection routing', () => {
	beforeEach(() => vi.clearAllMocks());

	it('routes a nested collection-meta delete to updateOne, never deleteOne', async () => {
		const current = snapshot({ collections: [stubCollection('articles', { note: 'x' })] });

		const diff = emptyDiff();
		diff.collections = [collectionDiff('articles', [{ kind: 'D', path: ['meta', 'note'], lhs: 'x' } as any])];

		await applyDiff(current, diff);

		expect(collections.updateOne).toHaveBeenCalledWith('articles', expect.anything(), expect.anything());
		expect(collections.deleteOne).not.toHaveBeenCalled();
	});

	it('routes a nested collection-meta create to updateOne, never createOne', async () => {
		const current = snapshot({ collections: [stubCollection('articles')] });
		const diff = emptyDiff();
		diff.collections = [collectionDiff('articles', [{ kind: 'N', path: ['meta', 'icon'], rhs: 'box' } as any])];

		await applyDiff(current, diff);

		expect(collections.updateOne).toHaveBeenCalledWith('articles', expect.anything(), expect.anything());
		expect(collections.createOne).not.toHaveBeenCalled();
	});

	it('still deletes a genuine whole-collection delete (no path)', async () => {
		const current = snapshot({ collections: [stubCollection('temp', { group: null })] });

		const diff = emptyDiff();

		diff.collections = [
			collectionDiff('temp', [{ kind: 'D', lhs: { collection: 'temp', meta: { group: null } } } as any]),
		];

		await applyDiff(current, diff);

		expect(collections.deleteOne).toHaveBeenCalledWith('temp', expect.anything());
	});

	it('still creates a genuine whole-collection create (no path)', async () => {
		const diff = emptyDiff();

		diff.collections = [
			collectionDiff('fresh', [
				{ kind: 'N', rhs: { collection: 'fresh', meta: { group: null }, schema: { name: 'fresh' } } } as any,
			]),
		];

		await applyDiff(snapshot(), diff);

		expect(collections.createOne).toHaveBeenCalledWith(
			expect.objectContaining({ collection: 'fresh' }),
			expect.anything()
		);
	});

	it('creates a new grouped child even when its existing parent only has a nested-meta change', async () => {
		const current = snapshot({ collections: [stubCollection('parent', { group: null })] });

		const diff = emptyDiff();

		diff.collections = [
			collectionDiff('parent', [{ kind: 'N', path: ['meta', 'icon'], rhs: 'box' } as any]),
			collectionDiff('child', [
				{ kind: 'N', rhs: { collection: 'child', meta: { group: 'parent' }, schema: { name: 'child' } } } as any,
			]),
		];

		await applyDiff(current, diff);

		expect(collections.createOne).toHaveBeenCalledWith(
			expect.objectContaining({ collection: 'child' }),
			expect.anything()
		);
	});
});
