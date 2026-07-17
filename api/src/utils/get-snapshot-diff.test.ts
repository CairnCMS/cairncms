import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../types/index.js';
import { getSnapshotDiff } from './get-snapshot-diff.js';

function snapshot(overrides: Partial<Snapshot>): Snapshot {
	return {
		version: 1,
		directus: '10.0.0',
		collections: [],
		fields: [],
		relations: [],
		...overrides,
	} as Snapshot;
}

const articlesCollection = (meta: Record<string, unknown>) =>
	({ collection: 'articles', meta, schema: { name: 'articles' } } as any);

const titleField = (note: string) =>
	({
		collection: 'articles',
		field: 'title',
		type: 'string',
		meta: { note },
		schema: { name: 'title' },
	} as any);

const authorRelation = (oneField: string) =>
	({
		collection: 'articles',
		field: 'author',
		related_collection: 'directus_users',
		meta: { one_field: oneField },
		schema: { table: 'articles', column: 'author' },
	} as any);

describe('getSnapshotDiff nested-meta suppression', () => {
	it('does not suppress field or relation diffs when the collection only has a nested meta change', () => {
		const current = snapshot({
			collections: [articlesCollection({ note: 'hello', sort: null })],
			fields: [titleField('old')],
			relations: [authorRelation('a')],
		});

		const after = snapshot({
			collections: [articlesCollection({ sort: null })],
			fields: [titleField('new')],
			relations: [authorRelation('b')],
		});

		const diff = getSnapshotDiff(current, after);

		expect(diff.fields.some((f) => f.collection === 'articles' && f.field === 'title')).toBe(true);
		expect(diff.relations.some((r) => r.collection === 'articles' && r.field === 'author')).toBe(true);
	});

	it('still suppresses field and relation diffs when the collection is genuinely deleted', () => {
		const current = snapshot({
			collections: [articlesCollection({ note: 'hello' })],
			fields: [titleField('old')],
			relations: [authorRelation('a')],
		});

		const after = snapshot({ collections: [], fields: [], relations: [] });

		const diff = getSnapshotDiff(current, after);

		expect(diff.fields.some((f) => f.collection === 'articles')).toBe(false);
		expect(diff.relations.some((r) => r.collection === 'articles')).toBe(false);
	});
});
