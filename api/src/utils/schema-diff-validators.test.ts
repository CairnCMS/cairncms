import type { Relation, SchemaOverview } from '@cairncms/types';
import type { Diff } from 'deep-diff';
import { cloneDeep, set, unset } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '../exceptions/index.js';
import {
	assertAliasTypeUnchanged,
	assertCollectionAbsent,
	assertCollectionAttributesKept,
	assertCollectionGroupAcyclic,
	assertCollectionGroupHasMetadata,
	assertCollectionNameAllowed,
	assertCollectionPresent,
	assertFieldAbsent,
	assertFieldAttributesKept,
	assertFieldTypeIsSupported,
	assertRelationAttributesKept,
	assertRelationConnectionKept,
	assertRelationCreatable,
	assertRelationModifiable,
} from './schema-diff-validators.js';

describe('collection group validators', () => {
	it('refuses a group without collection metadata', () => {
		expect(() => assertCollectionGroupHasMetadata('articles', 'content', false)).toThrow(
			`Collection "articles" can't be grouped under "content", which has no collection metadata.`
		);
	});

	it('accepts a group with collection metadata', () => {
		expect(() => assertCollectionGroupHasMetadata('articles', 'content', true)).not.toThrow();
	});

	it('refuses a group cycle', () => {
		expect(() => assertCollectionGroupAcyclic('articles', true)).toThrow(
			`Collection "articles" can't be grouped under itself through a group cycle.`
		);
	});

	it('accepts a group outside any cycle', () => {
		expect(() => assertCollectionGroupAcyclic('articles', false)).not.toThrow();
	});
});

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

describe('assertFieldAttributesKept', () => {
	const column = { name: 'title', table: 'articles', data_type: 'varchar', max_length: 1000 };

	it.each([
		['removed', { kind: 'D', path: ['schema'], lhs: column }],
		['set to null', { kind: 'E', path: ['schema'], lhs: column, rhs: null }],
	] as [string, Diff<unknown>][])('refuses a column %s', (_case, change) => {
		expect(() => assertFieldAttributesKept('articles', 'title', [change])).toThrow(
			`Field "articles.title" can't remove its column and remain as a field.`
		);
	});

	it.each([
		['removed', { kind: 'D', path: ['meta'], lhs: { note: 'Headline' } }],
		['set to null', { kind: 'E', path: ['meta'], lhs: { note: 'Headline' }, rhs: null }],
	] as [string, Diff<unknown>][])('refuses field metadata %s', (_case, change) => {
		expect(() => assertFieldAttributesKept('articles', 'title', [change])).toThrow(
			`Field "articles.title" can't remove its field metadata.`
		);
	});

	it('refuses a removed type', () => {
		expect(() =>
			assertFieldAttributesKept('articles', 'title', [{ kind: 'D', path: ['type'], lhs: 'string' }])
		).toThrow(`Field "articles.title" can't remove its type.`);
	});

	it.each(['max_length', 'default_value', 'is_nullable'])('refuses omitting schema.%s', (property) => {
		const omitted: Diff<unknown> = { kind: 'D', path: ['schema', property], lhs: null };

		expect(() => assertFieldAttributesKept('articles', 'title', [omitted])).toThrow(
			`Field "articles.title" can't omit "schema.${property}" from its column definition.`
		);
	});

	it('refuses a column added to a kept field', () => {
		expect(() =>
			assertFieldAttributesKept('articles', 'title', [{ kind: 'N', path: ['schema'], rhs: column }])
		).toThrow(`Field "articles.title" can't add a column to an existing field.`);
	});

	it('refuses a removal that follows an ordinary metadata edit', () => {
		const noteEdited: Diff<unknown> = { kind: 'E', path: ['meta', 'note'], lhs: null, rhs: 'Headline' };

		expect(() =>
			assertFieldAttributesKept('articles', 'title', [noteEdited, { kind: 'D', path: ['schema'], lhs: column }])
		).toThrow(`Field "articles.title" can't remove its column and remain as a field.`);
	});

	it.each([
		['removing metadata that is already null', { kind: 'D', path: ['meta'], lhs: null }],
		['an omitted metadata property', { kind: 'D', path: ['meta', 'note'], lhs: 'Headline' }],
		['gained metadata', { kind: 'E', path: ['meta'], lhs: null, rhs: { note: 'Headline' } }],
		['an explicit column property edit', { kind: 'E', path: ['schema', 'max_length'], lhs: 1000, rhs: 255 }],
		['a type change', { kind: 'E', path: ['type'], lhs: 'string', rhs: 'text' }],
	] as [string, Diff<unknown>][])('accepts %s', (_case, change) => {
		expect(() => assertFieldAttributesKept('articles', 'title', [change])).not.toThrow();
	});
});

describe('assertRelationAttributesKept', () => {
	const foreignKey = { table: 'articles', column: 'author', foreign_key_table: 'authors', foreign_key_column: 'id' };
	const meta = { many_collection: 'articles', many_field: 'author', one_collection: 'authors' };

	it.each([
		['removed', { kind: 'D', path: ['schema'], lhs: foreignKey }],
		['set to null', { kind: 'E', path: ['schema'], lhs: foreignKey, rhs: null }],
	] as [string, Diff<unknown>][])('refuses a foreign key %s', (_case, change) => {
		expect(() => assertRelationAttributesKept('articles', 'author', [change])).toThrow(
			`Relation "articles.author" can't remove its foreign key and remain as a relation.`
		);
	});

	it.each([
		['removed', { kind: 'D', path: ['meta'], lhs: meta }],
		['set to null', { kind: 'E', path: ['meta'], lhs: meta, rhs: null }],
	] as [string, Diff<unknown>][])('refuses relation metadata %s', (_case, change) => {
		expect(() => assertRelationAttributesKept('articles', 'author', [change])).toThrow(
			`Relation "articles.author" can't remove its relation metadata.`
		);
	});

	it.each([
		['removing metadata that is already null', { kind: 'D', path: ['meta'], lhs: null }],
		['an omitted metadata property', { kind: 'D', path: ['meta', 'sort_field'], lhs: 'sort' }],
		['an omitted foreign key property', { kind: 'D', path: ['schema', 'on_delete'], lhs: 'SET NULL' }],
	] as [string, Diff<unknown>][])('accepts %s', (_case, change) => {
		expect(() => assertRelationAttributesKept('articles', 'author', [change])).not.toThrow();
	});
});

describe('assertRelationConnectionKept', () => {
	const current = (): Relation => ({
		collection: 'articles',
		field: 'author',
		related_collection: 'authors',
		meta: {
			id: 1,
			many_collection: 'articles',
			many_field: 'author',
			one_collection: 'authors',
			one_field: null,
			one_collection_field: null,
			one_allowed_collections: null,
			one_deselect_action: 'nullify',
			junction_field: null,
			sort_field: null,
		},
		schema: {
			table: 'articles',
			column: 'author',
			foreign_key_table: 'authors',
			foreign_key_column: 'id',
			constraint_name: 'articles_author_foreign',
			on_update: 'NO ACTION',
			on_delete: 'SET NULL',
		},
	});

	const changedAt = (path: string, value: unknown): Relation => {
		const incoming = current();
		if (value === undefined) unset(incoming, path);
		else set(incoming, path, value);
		return incoming;
	};

	const targetChanged = `Relation "articles.author" can't change its related collection.`;
	const ownerChanged = `Relation "articles.author" can't change the field it belongs to.`;

	it.each([
		['related_collection', 'editors'],
		['meta.one_collection', 'editors'],
		['schema.foreign_key_table', 'editors'],
		['schema.foreign_key_column', 'uuid'],
		['meta.one_collection', undefined],
	])('refuses changing %s to %s', (path, value) => {
		expect(() => assertRelationConnectionKept(current(), changedAt(path, value), 'id')).toThrow(targetChanged);
	});

	it('refuses a related collection set on an any-to-any relation, which has none', () => {
		const anyToAny: Relation = {
			collection: 'articles',
			field: 'item',
			related_collection: null,
			schema: null,
			meta: {
				...current().meta!,
				many_field: 'item',
				one_collection: null,
				one_collection_field: 'collection',
				one_allowed_collections: ['authors', 'editors'],
			},
		};

		expect(() => assertRelationConnectionKept(anyToAny, cloneDeep(anyToAny), undefined)).not.toThrow();

		expect(() =>
			assertRelationConnectionKept(anyToAny, { ...cloneDeep(anyToAny), related_collection: 'authors' }, undefined)
		).toThrow(`Relation "articles.item" can't change its related collection.`);
	});

	it.each([
		['meta.many_collection', 'posts'],
		['meta.many_field', 'editor'],
		['schema.table', 'posts'],
		['schema.column', 'editor'],
	])('refuses changing %s to %s', (path, value) => {
		expect(() => assertRelationConnectionKept(current(), changedAt(path, value), 'id')).toThrow(ownerChanged);
	});

	it.each([
		['meta.sort_field', 'sort'],
		['schema.on_delete', 'CASCADE'],
		['meta.sort_field', undefined],
		['schema.on_delete', undefined],
	])('accepts changing %s to %s', (path, value) => {
		expect(() => assertRelationConnectionKept(current(), changedAt(path, value), 'id')).not.toThrow();
	});

	it('accepts metadata a native foreign key gains when it names the current connection, and refuses any other', () => {
		const nativeKey = (): Relation => ({ ...current(), meta: null });

		expect(() => assertRelationConnectionKept(nativeKey(), current(), 'id')).not.toThrow();

		expect(() => assertRelationConnectionKept(nativeKey(), changedAt('meta.one_collection', 'editors'), 'id')).toThrow(
			targetChanged
		);

		expect(() => assertRelationConnectionKept(nativeKey(), changedAt('meta.many_field', 'editor'), 'id')).toThrow(
			ownerChanged
		);
	});

	it('accepts a foreign key a metadata-only relation gains when it names the current connection, and refuses any other', () => {
		const metadataOnly = (): Relation => ({ ...current(), schema: null });

		expect(() => assertRelationConnectionKept(metadataOnly(), current(), 'id')).not.toThrow();

		expect(() =>
			assertRelationConnectionKept(metadataOnly(), changedAt('schema.foreign_key_table', 'editors'), 'id')
		).toThrow(targetChanged);

		expect(() => assertRelationConnectionKept(metadataOnly(), current(), 'uuid')).toThrow(targetChanged);

		expect(() => assertRelationConnectionKept(metadataOnly(), changedAt('schema.column', 'editor'), 'id')).toThrow(
			ownerChanged
		);
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
