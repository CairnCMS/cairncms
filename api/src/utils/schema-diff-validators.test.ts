import type { SchemaOverview } from '@cairncms/types';
import type { Diff } from 'deep-diff';
import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '../exceptions/index.js';
import {
	assertAliasTypeUnchanged,
	assertCollectionAbsent,
	assertCollectionAttributesKept,
	assertCollectionNameAllowed,
	assertCollectionPresent,
	assertFieldAbsent,
	assertFieldTypeIsSupported,
	assertRelationCreatable,
	assertRelationModifiable,
} from './schema-diff-validators.js';

describe('assertCollectionNameAllowed', () => {
	it('requires a collection name', () => {
		expect(() => assertCollectionNameAllowed(undefined)).toThrow('"collection" is required');
		expect(() => assertCollectionNameAllowed('')).toThrow('"collection" is required');
	});

	it('refuses the directus_ prefix', () => {
		expect(() => assertCollectionNameAllowed('directus_foo')).toThrow(`Collections can't start with "directus_"`);
	});

	it('accepts an ordinary name', () => {
		expect(() => assertCollectionNameAllowed('articles')).not.toThrow();
	});
});

describe('assertCollectionAbsent', () => {
	it('refuses an existing collection', () => {
		expect(() => assertCollectionAbsent('articles', new Set(['articles']))).toThrow(
			'Collection "articles" already exists.'
		);
	});

	it('accepts a new collection', () => {
		expect(() => assertCollectionAbsent('articles', new Set(['authors']))).not.toThrow();
	});
});

describe('assertCollectionPresent', () => {
	it('refuses an absent collection', () => {
		expect(() => assertCollectionPresent('ghost', new Set(['articles']))).toThrow(ForbiddenException);
	});

	it('accepts an existing collection', () => {
		expect(() => assertCollectionPresent('articles', new Set(['articles']))).not.toThrow();
	});
});

describe('assertCollectionAttributesKept', () => {
	const tableRemoved: Diff<unknown> = { kind: 'D', path: ['schema'], lhs: { name: 'articles' } };
	const metaRemoved: Diff<unknown> = { kind: 'D', path: ['meta'], lhs: { collection: 'articles' } };
	const metaNulled: Diff<unknown> = { kind: 'E', path: ['meta'], lhs: { collection: 'articles' }, rhs: null };
	const noteEdited: Diff<unknown> = { kind: 'E', path: ['meta', 'note'], lhs: null, rhs: 'Articles' };

	it('refuses removing the table of a kept collection', () => {
		expect(() => assertCollectionAttributesKept('articles', [tableRemoved])).toThrow(
			`Collection "articles" can't remove its table and remain as a collection.`
		);
	});

	it.each([
		['removed', metaRemoved],
		['set to null', metaNulled],
	])('refuses collection metadata %s', (_case, change) => {
		expect(() => assertCollectionAttributesKept('articles', [change])).toThrow(
			`Collection "articles" can't remove its collection metadata.`
		);
	});

	it('refuses a removal that follows an ordinary metadata edit', () => {
		expect(() => assertCollectionAttributesKept('articles', [noteEdited, metaRemoved])).toThrow(
			`Collection "articles" can't remove its collection metadata.`
		);
	});

	it('accepts removing metadata that is already null', () => {
		expect(() => assertCollectionAttributesKept('articles', [{ kind: 'D', path: ['meta'], lhs: null }])).not.toThrow();
	});

	it('accepts nested metadata edits and whole-collection changes', () => {
		const deleted: Diff<unknown> = { kind: 'D', lhs: { collection: 'articles', meta: null, schema: null } };

		expect(() => assertCollectionAttributesKept('articles', [noteEdited])).not.toThrow();
		expect(() => assertCollectionAttributesKept('articles', [deleted])).not.toThrow();
	});
});

describe('assertFieldAbsent', () => {
	it('refuses an existing field', () => {
		expect(() => assertFieldAbsent('articles', 'title', true)).toThrow(
			'Field "title" already exists in collection "articles"'
		);
	});

	it('accepts a new field', () => {
		expect(() => assertFieldAbsent('articles', 'title', false)).not.toThrow();
	});
});

describe('assertAliasTypeUnchanged', () => {
	it('refuses changing a field to an alias type', () => {
		expect(() => assertAliasTypeUnchanged('alias', 'string')).toThrow('Alias type cannot be changed');
	});

	it('refuses changing a field away from an alias type', () => {
		expect(() => assertAliasTypeUnchanged('string', 'alias')).toThrow('Alias type cannot be changed');
	});

	it('allows a non-alias type change', () => {
		expect(() => assertAliasTypeUnchanged('string', 'integer')).not.toThrow();
	});

	it('allows an unchanged alias type', () => {
		expect(() => assertAliasTypeUnchanged('alias', 'alias')).not.toThrow();
	});

	it('does nothing when no incoming type is given', () => {
		expect(() => assertAliasTypeUnchanged(undefined, 'alias')).not.toThrow();
	});

	it('treats a missing current type as alias', () => {
		expect(() => assertAliasTypeUnchanged('alias', undefined)).not.toThrow();
		expect(() => assertAliasTypeUnchanged('string', undefined)).not.toThrow();
	});
});

describe('assertFieldTypeIsSupported', () => {
	it('accepts alias and unknown without building a column', () => {
		expect(() => assertFieldTypeIsSupported({ type: 'alias' } as never)).not.toThrow();
		expect(() => assertFieldTypeIsSupported({ type: 'unknown' } as never)).not.toThrow();
	});

	it('accepts an auto-increment field of an otherwise-unsupported type', () => {
		expect(() =>
			assertFieldTypeIsSupported({ type: 'wibble', schema: { has_auto_increment: true } } as never)
		).not.toThrow();
	});

	it('accepts a geometry type', () => {
		expect(() => assertFieldTypeIsSupported({ type: 'geometry.Point' } as never)).not.toThrow();
	});

	it('accepts a known knex type', () => {
		expect(() => assertFieldTypeIsSupported({ type: 'boolean' } as never)).not.toThrow();
	});

	it('refuses an unknown type', () => {
		expect(() => assertFieldTypeIsSupported({ type: 'wibble' } as never)).toThrow('Illegal type passed: "wibble"');
	});
});

describe('relation validators', () => {
	const schema = {
		collections: {
			articles: { collection: 'articles', primary: 'id', fields: { id: {}, author: {}, bound: {} } },
			authors: { collection: 'authors', primary: 'id', fields: { id: {} } },
		},
		relations: [{ collection: 'articles', field: 'bound', related_collection: 'authors' }],
	} as unknown as SchemaOverview;

	describe('assertRelationCreatable', () => {
		it('requires a collection and a field', () => {
			expect(() => assertRelationCreatable({ field: 'author' }, schema)).toThrow('"collection" is required');
			expect(() => assertRelationCreatable({ collection: 'articles' }, schema)).toThrow('"field" is required');
		});

		it('refuses an unknown collection or field', () => {
			expect(() => assertRelationCreatable({ collection: 'ghost', field: 'author' }, schema)).toThrow(
				`Collection "ghost" doesn't exist`
			);

			expect(() => assertRelationCreatable({ collection: 'articles', field: 'ghost' }, schema)).toThrow(
				`Field "ghost" doesn't exist in collection "articles"`
			);
		});

		it('refuses a primary key field', () => {
			expect(() => assertRelationCreatable({ collection: 'articles', field: 'id' }, schema)).toThrow(
				`Field "id" in collection "articles" is a primary key`
			);
		});

		it('refuses an unknown related collection', () => {
			expect(() =>
				assertRelationCreatable({ collection: 'articles', field: 'author', related_collection: 'ghost' }, schema)
			).toThrow(`Collection "ghost" doesn't exist`);
		});

		it('refuses a field that already has a relationship', () => {
			expect(() => assertRelationCreatable({ collection: 'articles', field: 'bound' }, schema)).toThrow(
				`Field "bound" in collection "articles" already has an associated relationship`
			);
		});

		it('accepts a valid new relation', () => {
			expect(() =>
				assertRelationCreatable({ collection: 'articles', field: 'author', related_collection: 'authors' }, schema)
			).not.toThrow();
		});
	});

	describe('assertRelationModifiable', () => {
		it('refuses an unknown collection or field', () => {
			expect(() => assertRelationModifiable('ghost', 'bound', schema)).toThrow(`Collection "ghost" doesn't exist`);

			expect(() => assertRelationModifiable('articles', 'ghost', schema)).toThrow(
				`Field "ghost" doesn't exist in collection "articles"`
			);
		});

		it('refuses a field without a relationship', () => {
			expect(() => assertRelationModifiable('articles', 'author', schema)).toThrow(
				`Field "author" in collection "articles" doesn't have a relationship.`
			);
		});

		it('accepts a field with a relationship', () => {
			expect(() => assertRelationModifiable('articles', 'bound', schema)).not.toThrow();
		});
	});
});
