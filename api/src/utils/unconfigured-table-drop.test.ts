import type { DeepPartial } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import type { Collection } from '../types/index.js';
import { isUnconfiguredTableDrop, unconfiguredTableDropMessage } from './unconfigured-table-drop.js';

function collectionDef(parts: DeepPartial<Collection>): Collection {
	const draft: DeepPartial<Collection> = { collection: 'x', meta: null, schema: null, ...parts };
	return draft as Collection;
}

describe('isUnconfiguredTableDrop', () => {
	it('is true for a table with no metadata row', () => {
		expect(isUnconfiguredTableDrop(collectionDef({ schema: { name: 'legacy' }, meta: null }))).toBe(true);
	});

	it('is false for a configured collection with a metadata row', () => {
		expect(
			isUnconfiguredTableDrop(collectionDef({ schema: { name: 'articles' }, meta: { collection: 'articles' } }))
		).toBe(false);
	});

	it('is false for a metadata-only folder with no table', () => {
		expect(isUnconfiguredTableDrop(collectionDef({ schema: null, meta: { collection: 'folder' } }))).toBe(false);
	});

	it('is false for an undefined definition', () => {
		expect(isUnconfiguredTableDrop(undefined)).toBe(false);
	});
});

describe('unconfiguredTableDropMessage', () => {
	it('names the table and warns it may belong to another application', () => {
		expect(unconfiguredTableDropMessage('legacy_posts')).toBe(
			'Deleting table "legacy_posts" will remove its data. It has no CairnCMS collection record and may belong to another application.'
		);
	});

	it('sanitizes control characters in the table name', () => {
		const bell = String.fromCharCode(7);
		const message = unconfiguredTableDropMessage(`legacy${bell}`);
		expect(message).toContain('legacy?');
		expect(message).not.toContain(bell);
	});
});
