import type { Diff, DiffDeleted, DiffNew } from 'deep-diff';
import { describe, expect, it } from 'vitest';
import type { CollectionMeta } from '../types/collection.js';
import type { Collection, SnapshotDiff } from '../types/index.js';
import { collectionDeleteOrder } from './schema-collection-order.js';

type CollectionChange = SnapshotDiff['collections'][number];

function definition(collection: string, group: string | null): Collection {
	return {
		collection,
		meta: { collection, group } as CollectionMeta,
		schema: { name: collection } as Collection['schema'],
	};
}

function deleted(collection: string, group: string | null = null): CollectionChange {
	const change: DiffDeleted<Collection> = { kind: 'D', lhs: definition(collection, group) };
	return { collection, diff: [change] };
}

function deletedWithoutMetadata(collection: string): CollectionChange {
	const change: DiffDeleted<Collection> = { kind: 'D', lhs: { ...definition(collection, null), meta: null } };
	return { collection, diff: [change] };
}

function attributeChange(collection: string, change: Diff<unknown>): CollectionChange {
	return { collection, diff: [change as Diff<Collection | undefined>] };
}

function diffOf(...collections: CollectionChange[]): SnapshotDiff {
	return { collections, fields: [], relations: [] };
}

describe('collectionDeleteOrder', () => {
	it('lists a dropped top-level collection', () => {
		expect(collectionDeleteOrder(diffOf(deleted('articles')))).toEqual(['articles']);
	});

	it('lists a dropped collection whose group survives', () => {
		expect(collectionDeleteOrder(diffOf(deleted('articles', 'content')))).toEqual(['articles']);
	});

	it('lists a dropped collection that has no metadata row', () => {
		expect(collectionDeleteOrder(diffOf(deletedWithoutMetadata('imported')))).toEqual(['imported']);
	});

	it('lists dropped children before the dropped collections they are grouped under', () => {
		const order = collectionDeleteOrder(
			diffOf(deleted('archive', 'content'), deleted('articles', 'archive'), deleted('comments', 'articles'))
		);

		expect(order).toEqual(['comments', 'articles', 'archive']);
	});

	it('lists each member of a group cycle once', () => {
		const order = collectionDeleteOrder(diffOf(deleted('a', 'b'), deleted('b', 'a')));

		expect(order).toHaveLength(2);
		expect(new Set(order)).toEqual(new Set(['a', 'b']));
	});

	it('keeps a child grouped under a cycle member ahead of that member', () => {
		const order = collectionDeleteOrder(diffOf(deleted('a', 'b'), deleted('b', 'a'), deleted('c', 'a')));

		expect(order).toEqual(['b', 'c', 'a']);
	});

	it('ignores collections the diff creates or updates', () => {
		const created: DiffNew<Collection> = { kind: 'N', rhs: definition('pages', null) };

		const diff = diffOf(
			deleted('legacy'),
			{ collection: 'pages', diff: [created] },
			attributeChange('posts', { kind: 'E', path: ['meta', 'note'], lhs: null, rhs: 'Posts' }),
			attributeChange('tags', { kind: 'D', path: ['meta', 'translations'], lhs: { en: 'Tags' } })
		);

		expect(collectionDeleteOrder(diff)).toEqual(['legacy']);
	});

	it('ignores the removal of a single collection attribute', () => {
		const diff = diffOf(
			attributeChange('articles', { kind: 'D', path: ['schema'], lhs: { name: 'articles' } }),
			attributeChange('pages', { kind: 'D', path: ['meta'], lhs: { collection: 'pages', group: null } })
		);

		expect(collectionDeleteOrder(diff)).toEqual([]);
	});
});
