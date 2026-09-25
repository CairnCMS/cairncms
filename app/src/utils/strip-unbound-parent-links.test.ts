import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Field, Relation } from '@cairncms/types';
import { useFieldsStore } from '@/stores/fields';
import { useRelationsStore } from '@/stores/relations';
import { stripUnboundParentLinks } from '@/utils/strip-unbound-parent-links';

type FieldSchema = NonNullable<Field['schema']>;
type FieldRelationMeta = NonNullable<Relation['meta']>;

function columnSchema(overrides: Partial<FieldSchema> = {}): FieldSchema {
	return {
		name: '',
		table: '',
		data_type: 'integer',
		default_value: null,
		max_length: null,
		numeric_precision: null,
		numeric_scale: null,
		is_nullable: true,
		is_unique: false,
		is_primary_key: false,
		is_generated: false,
		has_auto_increment: false,
		foreign_key_table: null,
		foreign_key_column: null,
		...overrides,
	};
}

function field(collection: string, name: string, primary = false, dataType: Field['type'] = 'integer'): Field {
	return {
		collection,
		field: name,
		name,
		type: primary ? dataType : 'string',
		schema: primary ? columnSchema({ is_primary_key: true, data_type: dataType }) : null,
		meta: null,
		children: null,
	};
}

function relationMeta(overrides: Partial<FieldRelationMeta> = {}): FieldRelationMeta {
	return {
		id: 0,
		many_collection: '',
		many_field: '',
		one_collection: null,
		one_field: null,
		one_collection_field: null,
		one_allowed_collections: null,
		one_deselect_action: 'nullify',
		junction_field: null,
		sort_field: null,
		...overrides,
	};
}

function relation(partial: {
	collection: string;
	field: string;
	related_collection?: string | null;
	meta?: Partial<FieldRelationMeta>;
}): Relation {
	return {
		collection: partial.collection,
		field: partial.field,
		related_collection: partial.related_collection ?? null,
		schema: null,
		meta: relationMeta(partial.meta),
	};
}

function seed() {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	const fieldsStore = useFieldsStore();
	const relationsStore = useRelationsStore();

	fieldsStore.fields = [
		field('articles', 'id', true),
		field('articles', 'sections'),
		field('articles', 'tags'),
		field('articles', 'blocks'),
		field('articles', 'author'),
		field('sections', 'id', true),
		field('sections', 'paragraphs'),
		field('paragraphs', 'id', true),
		field('paragraphs', 'section_id'),
		field('tags', 'id', true),
		field('articles_tags', 'id', true),
		field('articles_tags', 'article_id'),
		field('articles_tags', 'tag_id'),
		field('articles_blocks', 'id', true),
		field('articles_blocks', 'article_id'),
		field('articles_blocks', 'item'),
		field('articles_blocks', 'collection'),
		field('headings', 'id', true),
		field('headings', 'notes'),
		field('notes', 'id', true),
		field('directus_users', 'id', true, 'string'),
		field('directus_users', 'favorites'),
		field('favorites', 'id', true),
	];

	relationsStore.relations = [
		relation({
			collection: 'sections',
			field: 'article_id',
			related_collection: 'articles',
			meta: { one_field: 'sections', many_field: 'article_id' },
		}),
		relation({
			collection: 'paragraphs',
			field: 'section_id',
			related_collection: 'sections',
			meta: { one_field: 'paragraphs', many_field: 'section_id' },
		}),
		relation({
			collection: 'articles_tags',
			field: 'article_id',
			related_collection: 'articles',
			meta: { one_field: 'tags', junction_field: 'tag_id' },
		}),
		relation({
			collection: 'articles_tags',
			field: 'tag_id',
			related_collection: 'tags',
			meta: { junction_field: 'article_id' },
		}),
		relation({
			collection: 'articles_blocks',
			field: 'article_id',
			related_collection: 'articles',
			meta: { one_field: 'blocks', junction_field: 'item' },
		}),
		relation({
			collection: 'articles_blocks',
			field: 'item',
			related_collection: null,
			meta: { junction_field: 'article_id', one_collection_field: 'collection', one_allowed_collections: ['headings'] },
		}),
		relation({
			collection: 'articles',
			field: 'author',
			related_collection: 'directus_users',
		}),
		relation({
			collection: 'favorites',
			field: 'user_id',
			related_collection: 'directus_users',
			meta: { one_field: 'favorites', many_field: 'user_id' },
		}),
		relation({
			collection: 'notes',
			field: 'heading_id',
			related_collection: 'headings',
			meta: { one_field: 'notes', many_field: 'heading_id' },
		}),
	];
}

beforeEach(seed);

describe('stripUnboundParentLinks', () => {
	it('strips the o2m reverse marker under an unbound parent', () => {
		const payload = { name: 'New', sections: { create: [{ article_id: '+', title: 'Intro' }] } };
		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.sections.create[0]).toEqual({ title: 'Intro' });
	});

	it('strips the m2m reverse marker under an unbound parent while keeping the related link', () => {
		const payload = { tags: { create: [{ article_id: '+', tag_id: { id: 5 } }] } };
		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.tags.create[0]).toEqual({ tag_id: { id: 5 } });
	});

	it('strips the m2a reverse marker under an unbound parent while keeping the discriminator and item', () => {
		const payload = { blocks: { create: [{ article_id: '+', collection: 'headings', item: { title: 'H' } }] } };
		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.blocks.create[0]).toEqual({ collection: 'headings', item: { title: 'H' } });
	});

	it('recurses into a nested m2o object body to strip a deep o2m marker when the nested parent is unbound', () => {
		const payload = { author: { name: 'Ann', favorites: { create: [{ user_id: '+', title: 'Fav' }] } } };
		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.author.favorites.create[0]).toEqual({ title: 'Fav' });
	});

	it('keeps a supplied child link on an m2o update whose existing record key is the literal marker', () => {
		const payload = { author: { id: '+', favorites: { create: [{ user_id: '+', title: 'Fav' }] } } };
		const result = stripUnboundParentLinks('articles', payload, true);
		expect(result.author).toEqual({ id: '+', favorites: { create: [{ user_id: '+', title: 'Fav' }] } });
	});

	it('recurses through a new m2a item body to strip its own deep o2m marker', () => {
		const payload = {
			blocks: {
				create: [
					{ article_id: '+', collection: 'headings', item: { notes: { create: [{ heading_id: '+', body: 'n' }] } } },
				],
			},
		};

		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.blocks.create[0].article_id).toBeUndefined();
		expect(result.blocks.create[0].item.notes.create[0]).toEqual({ body: 'n' });
	});

	it('classifies a create entry as unbound by operation even when it carries a primary key', () => {
		const payload = {
			sections: { create: [{ id: 50, title: 'S', paragraphs: { create: [{ section_id: '+', body: 'P' }] } }] },
		};

		const result = stripUnboundParentLinks('articles', payload, true);
		expect(result.sections.create[0].id).toBe(50);
		expect(result.sections.create[0].paragraphs.create[0]).toEqual({ body: 'P' });
	});

	it('classifies an update entry with a real key as bound so an authored deep marker survives', () => {
		const payload = {
			sections: { update: [{ id: 50, title: 'S', paragraphs: { create: [{ section_id: '+', body: 'P' }] } }] },
		};

		const result = stripUnboundParentLinks('articles', payload, true);
		expect(result.sections.update[0].paragraphs.create[0]).toEqual({ section_id: '+', body: 'P' });
	});

	it('handles object-array relationship payloads (saveAsCopy shape)', () => {
		const payload = { sections: [{ article_id: '+', title: 'Intro' }] };
		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.sections[0]).toEqual({ title: 'Intro' });
	});

	it('preserves an authored marker under a bound parent so the server guard still fires', () => {
		const payload = { sections: { update: [{ id: 7, article_id: '+', title: 'Changed' }] } };
		const result = stripUnboundParentLinks('articles', payload, true);
		expect(result.sections.update[0]).toEqual({ id: 7, article_id: '+', title: 'Changed' });
	});

	it('preserves a genuine conflicting real-key link', () => {
		const payload = { sections: { create: [{ article_id: 99, title: 'Intro' }] } };
		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.sections.create[0]).toEqual({ article_id: 99, title: 'Intro' });
	});

	it('preserves an explicit null reverse field, since an intentional unlink is not the marker', () => {
		const payload = { sections: { create: [{ article_id: null, title: 'Intro' }] } };
		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.sections.create[0]).toEqual({ article_id: null, title: 'Intro' });
	});

	it('treats an object-array entry with a zero key as bound, stripping its own reverse but keeping its children markers', () => {
		const payload = {
			sections: [{ id: 0, article_id: '+', paragraphs: { create: [{ section_id: '+', body: 'P' }] } }],
		};

		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.sections[0].article_id).toBeUndefined();
		expect(result.sections[0].id).toBe(0);
		expect(result.sections[0].paragraphs.create[0]).toEqual({ section_id: '+', body: 'P' });
	});

	it('treats an object-array entry with a null key as unbound, stripping its children markers and keeping null values', () => {
		const payload = {
			sections: [{ id: null, title: null, paragraphs: { create: [{ section_id: '+', body: 'P' }] } }],
		};

		const result = stripUnboundParentLinks('articles', payload, true);
		expect(result.sections[0].id).toBeNull();
		expect(result.sections[0].title).toBeNull();
		expect(result.sections[0].paragraphs.create[0]).toEqual({ body: 'P' });
	});

	it('leaves delete lists and scalar-key arrays untouched', () => {
		const payload = { sections: { delete: [1, 2] }, tags: [3, 4] };
		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.sections.delete).toEqual([1, 2]);
		expect(result.tags).toEqual([3, 4]);
	});

	it('leaves unrelated JSON untouched even when it contains a marker', () => {
		const payload = { metadata: { note: '+' }, sections: { create: [{ article_id: '+', title: 'x' }] } };
		const result = stripUnboundParentLinks('articles', payload, false);
		expect(result.metadata).toEqual({ note: '+' });
		expect(result.sections.create[0]).toEqual({ title: 'x' });
	});

	it('does not mutate the input payload', () => {
		const payload = { sections: { create: [{ article_id: '+', title: 'x' }] } };
		stripUnboundParentLinks('articles', payload, false);
		expect(payload.sections.create[0]).toEqual({ article_id: '+', title: 'x' });
	});

	it('returns non-object payloads unchanged', () => {
		expect(stripUnboundParentLinks('articles', null, false)).toBeNull();
		expect(stripUnboundParentLinks('articles', 5, false)).toBe(5);
	});
});
