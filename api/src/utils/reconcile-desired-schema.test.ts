import type { DeepPartial } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import type { Collection, Snapshot, SnapshotField, SnapshotRelation } from '../types/index.js';
import { reconcileDesiredSchema } from './reconcile-desired-schema.js';

function snapshot(parts: Partial<Snapshot>): Snapshot {
	return { version: 1, directus: '1.0.0', collections: [], fields: [], relations: [], ...parts };
}

function fieldOf(collection: string, field: string, body: DeepPartial<SnapshotField>): SnapshotField {
	const draft: DeepPartial<SnapshotField> = { collection, field, type: 'string', ...body };
	return draft as SnapshotField;
}

function collectionOf(collection: string, body: DeepPartial<Collection>): Collection {
	const draft: DeepPartial<Collection> = { collection, ...body };
	return draft as Collection;
}

function relationOf(body: DeepPartial<SnapshotRelation>): SnapshotRelation {
	const draft: DeepPartial<SnapshotRelation> = { ...body };
	return draft as SnapshotRelation;
}

function firstField(result: Snapshot): SnapshotField {
	return result.fields[0]!;
}

describe('reconcileDesiredSchema fills omitted inner properties', () => {
	it('fills an omitted meta and schema property from the current field', () => {
		const current = snapshot({
			fields: [
				fieldOf('articles', 'title', {
					meta: { note: 'Headline', width: 'full' },
					schema: { name: 'title', data_type: 'varchar', max_length: 1000, default_value: 'Untitled' },
				}),
			],
		});

		const desired = snapshot({
			fields: [
				fieldOf('articles', 'title', {
					meta: { width: 'half' },
					schema: { name: 'title', data_type: 'varchar', default_value: 'Untitled' },
				}),
			],
		});

		const result = reconcileDesiredSchema(current, desired);

		expect(firstField(result).meta).toEqual({ width: 'half', note: 'Headline' });

		expect(firstField(result).schema).toEqual({
			name: 'title',
			data_type: 'varchar',
			default_value: 'Untitled',
			max_length: 1000,
		});
	});

	it('fills an omitted numeric scale from the current column', () => {
		const current = snapshot({
			fields: [
				fieldOf('a', 'amount', {
					type: 'decimal',
					schema: { name: 'amount', data_type: 'decimal', numeric_precision: 10, numeric_scale: 2 },
				}),
			],
		});

		const desired = snapshot({
			fields: [
				fieldOf('a', 'amount', {
					type: 'decimal',
					schema: { name: 'amount', data_type: 'decimal', numeric_precision: 12 },
				}),
			],
		});

		const result = reconcileDesiredSchema(current, desired);

		expect(firstField(result).schema).toEqual({
			name: 'amount',
			data_type: 'decimal',
			numeric_precision: 12,
			numeric_scale: 2,
		});
	});

	it('leaves a declared property value, including null, empty object, empty array, false, and zero', () => {
		const current = snapshot({
			fields: [
				fieldOf('a', 'f', {
					meta: { note: 'kept', hidden: true, options: { a: 1 }, conditions: [{ name: 'c' }], sort: 5 },
				}),
			],
		});

		const desired = snapshot({
			fields: [fieldOf('a', 'f', { meta: { note: null, hidden: false, options: {}, conditions: [], sort: 0 } })],
		});

		const result = reconcileDesiredSchema(current, desired);

		expect(firstField(result).meta).toEqual({ note: null, hidden: false, options: {}, conditions: [], sort: 0 });
	});

	it('replaces a declared object whole without inheriting a sub-key', () => {
		const current = snapshot({
			fields: [fieldOf('a', 'f', { meta: { options: { folder: 'images', template: 'T', limit: 5 } } })],
		});

		const desired = snapshot({ fields: [fieldOf('a', 'f', { meta: { options: { folder: 'docs' } } })] });

		const result = reconcileDesiredSchema(current, desired);

		expect(firstField(result).meta.options).toEqual({ folder: 'docs' });
	});

	it('treats an empty meta or schema container as every direct property omitted', () => {
		const current = snapshot({
			fields: [
				fieldOf('a', 'f', {
					meta: { note: 'x', width: 'full' },
					schema: { name: 'f', data_type: 'varchar', max_length: 20 },
				}),
			],
		});

		const desired = snapshot({ fields: [fieldOf('a', 'f', { meta: {}, schema: {} })] });

		const result = reconcileDesiredSchema(current, desired);

		expect(firstField(result).meta).toEqual({ note: 'x', width: 'full' });
		expect(firstField(result).schema).toEqual({ name: 'f', data_type: 'varchar', max_length: 20 });
	});

	it('does not add a meta or schema object the file omits entirely', () => {
		const current = snapshot({
			fields: [fieldOf('a', 'f', { meta: { note: 'x' }, schema: { name: 'f', data_type: 'varchar' } })],
		});

		const desired = snapshot({ fields: [fieldOf('a', 'f', {})] });

		const result = reconcileDesiredSchema(current, desired);

		expect(Object.hasOwn(firstField(result), 'meta')).toBe(false);
		expect(Object.hasOwn(firstField(result), 'schema')).toBe(false);
	});

	it('leaves an entity that exists on only one side untouched', () => {
		const current = snapshot({ fields: [fieldOf('a', 'f', { meta: { note: 'x' } })] });
		const desired = snapshot({ fields: [fieldOf('a', 'g', { meta: {} })] });

		const result = reconcileDesiredSchema(current, desired);

		expect(firstField(result).meta).toEqual({});
	});

	it('does not mutate the input desired or current', () => {
		const currentField = fieldOf('a', 'f', { meta: { note: 'x' } });
		const desiredField = fieldOf('a', 'f', { meta: {} });

		reconcileDesiredSchema(snapshot({ fields: [currentField] }), snapshot({ fields: [desiredField] }));

		expect(desiredField.meta).toEqual({});
		expect(currentField.meta).toEqual({ note: 'x' });
	});

	it('fills an omitted collection meta property and the collection schema name', () => {
		const current = snapshot({
			collections: [collectionOf('a', { meta: { icon: 'box', note: 'n' }, schema: { name: 'a' } })],
		});

		const desired = snapshot({ collections: [collectionOf('a', { meta: { icon: 'star' }, schema: {} })] });

		const result = reconcileDesiredSchema(current, desired);

		expect(result.collections[0]!.meta).toEqual({ icon: 'star', note: 'n' });
		expect(result.collections[0]!.schema).toEqual({ name: 'a' });
	});

	it('fills an omitted relation meta and schema property', () => {
		const current = snapshot({
			relations: [
				relationOf({
					collection: 'a',
					field: 'author',
					related_collection: 'authors',
					meta: { sort_field: 'position', one_field: 'x' },
					schema: { table: 'a', column: 'author', foreign_key_table: 'authors', on_delete: 'SET NULL' },
				}),
			],
		});

		const desired = snapshot({
			relations: [
				relationOf({
					collection: 'a',
					field: 'author',
					related_collection: 'authors',
					meta: { one_field: 'x' },
					schema: { table: 'a', column: 'author', foreign_key_table: 'authors' },
				}),
			],
		});

		const result = reconcileDesiredSchema(current, desired);

		expect(result.relations[0]!.meta.sort_field).toBe('position');
		expect(result.relations[0]!.schema!.on_delete).toBe('SET NULL');
	});
});

describe('reconcileDesiredSchema refuses a folder reference that crosses the interface boundary', () => {
	it('refuses entering the registry while omitting options, naming the property', () => {
		const current = snapshot({
			fields: [fieldOf('a', 'f', { meta: { interface: 'custom-widget', options: { folder: 'images' } } })],
		});

		const desired = snapshot({ fields: [fieldOf('a', 'f', { meta: { interface: 'file' } })] });

		expect(() => reconcileDesiredSchema(current, desired)).toThrow(/can't omit "meta.options"/);
	});

	it('refuses leaving the registry while omitting options, asking to restate it', () => {
		const current = snapshot({
			fields: [fieldOf('a', 'f', { meta: { interface: 'file', options: { folder: 'images' } } })],
		});

		const desired = snapshot({ fields: [fieldOf('a', 'f', { meta: { interface: 'custom-widget' } })] });

		expect(() => reconcileDesiredSchema(current, desired)).toThrow(/Restate "meta.options"/);
	});

	it('names conditions when an inherited condition reference crosses the boundary', () => {
		const current = snapshot({
			fields: [
				fieldOf('a', 'f', {
					meta: {
						interface: 'file',
						options: { template: 'x' },
						conditions: [{ name: 'c', options: { folder: 'images' } }],
					},
				}),
			],
		});

		const desired = snapshot({
			fields: [fieldOf('a', 'f', { meta: { interface: 'custom-widget', options: { template: 'x' } } })],
		});

		expect(() => reconcileDesiredSchema(current, desired)).toThrow(/meta.conditions/);
	});

	it('sanitizes control characters out of the refusal diagnostic', () => {
		const bel = String.fromCharCode(7);

		const current = snapshot({
			fields: [fieldOf(`media${bel}`, 'cover', { meta: { interface: 'file', options: { folder: 'images' } } })],
		});

		const desired = snapshot({ fields: [fieldOf(`media${bel}`, 'cover', { meta: { interface: 'custom-widget' } })] });

		let message = '';

		try {
			reconcileDesiredSchema(current, desired);
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain('media?.cover');
		expect(message).not.toContain(bel);
	});

	it('does not refuse when the interface is unchanged', () => {
		const current = snapshot({
			fields: [fieldOf('a', 'f', { meta: { interface: 'file', options: { folder: 'images' } } })],
		});

		const desired = snapshot({ fields: [fieldOf('a', 'f', { meta: { note: 'x' } })] });

		const result = reconcileDesiredSchema(current, desired);

		expect(firstField(result).meta).toEqual({ note: 'x', interface: 'file', options: { folder: 'images' } });
	});

	it('does not refuse when both interfaces are registered', () => {
		const current = snapshot({
			fields: [fieldOf('a', 'f', { meta: { interface: 'file', options: { folder: 'images' } } })],
		});

		const desired = snapshot({ fields: [fieldOf('a', 'f', { meta: { interface: 'file-image' } })] });

		const result = reconcileDesiredSchema(current, desired);

		expect(firstField(result).meta).toEqual({ interface: 'file-image', options: { folder: 'images' } });
	});

	it('does not refuse a boundary change when the options are explicitly restated', () => {
		const current = snapshot({
			fields: [fieldOf('a', 'f', { meta: { interface: 'file', options: { folder: 'images' } } })],
		});

		const desired = snapshot({
			fields: [fieldOf('a', 'f', { meta: { interface: 'custom-widget', options: { folder: 'images' } } })],
		});

		expect(() => reconcileDesiredSchema(current, desired)).not.toThrow();
	});

	it('does not refuse when the inherited options carry no folder reference', () => {
		const current = snapshot({
			fields: [fieldOf('a', 'f', { meta: { interface: 'custom-widget', options: { template: 'x' } } })],
		});

		const desired = snapshot({ fields: [fieldOf('a', 'f', { meta: { interface: 'file' } })] });

		const result = reconcileDesiredSchema(current, desired);

		expect(firstField(result).meta).toEqual({ interface: 'file', options: { template: 'x' } });
	});
});
