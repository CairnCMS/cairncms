import { describe, expect, it } from 'vitest';
import {
	parseJsonColumn,
	visitFolderReferences,
	type FolderReferenceMeta,
	type FolderReferencePath,
} from './folder-references.js';

function collect(meta: FolderReferenceMeta): Array<{ path: FolderReferencePath; value: unknown }> {
	const visited: Array<{ path: FolderReferencePath; value: unknown }> = [];
	visitFolderReferences(meta, (path, value) => visited.push({ path, value }));
	return visited;
}

describe('visitFolderReferences', () => {
	it.each(['file', 'file-image', 'files', 'input-rich-text-html', 'input-rich-text-md'])(
		'visits the top-level folder option of %s',
		(interfaceId) => {
			expect(collect({ interface: interfaceId, options: { folder: 'f-1', other: 'x' } })).toEqual([
				{ path: ['options', 'folder'], value: 'f-1' },
			]);
		}
	);

	it('visits a rich-text sub-field of a repeater', () => {
		const meta = {
			interface: 'list',
			options: {
				fields: [
					{ field: 'title', meta: { interface: 'input', options: { folder: 'ignored' } } },
					{ field: 'body', meta: { interface: 'input-rich-text-md', options: { folder: 'f-1' } } },
				],
			},
		};

		expect(collect(meta)).toEqual([{ path: ['options', 'fields', 1, 'meta', 'options', 'folder'], value: 'f-1' }]);
	});

	it('visits a repeater nested inside a repeater', () => {
		const meta = {
			interface: 'list',
			options: {
				fields: [
					{
						field: 'items',
						meta: {
							interface: 'list',
							options: {
								fields: [{ field: 'body', meta: { interface: 'input-rich-text-html', options: { folder: 'f-1' } } }],
							},
						},
					},
				],
			},
		};

		expect(collect(meta)).toEqual([
			{ path: ['options', 'fields', 0, 'meta', 'options', 'fields', 0, 'meta', 'options', 'folder'], value: 'f-1' },
		]);
	});

	it("visits condition option overrides with the field's own interface", () => {
		expect(
			collect({
				interface: 'file',
				options: null,
				conditions: [
					{ name: 'a', rule: {}, readonly: true },
					{ name: 'b', rule: {}, options: { folder: 'f-1' } },
				],
			})
		).toEqual([{ path: ['conditions', 1, 'options', 'folder'], value: 'f-1' }]);

		expect(
			collect({
				interface: 'list',
				conditions: [
					{
						name: 'a',
						rule: {},
						options: {
							fields: [{ field: 'body', meta: { interface: 'input-rich-text-md', options: { folder: 'f-2' } } }],
						},
					},
				],
			})
		).toEqual([{ path: ['conditions', 0, 'options', 'fields', 0, 'meta', 'options', 'folder'], value: 'f-2' }]);
	});

	it("visits a repeater sub-field's own conditions with the sub-field's interface", () => {
		const meta = {
			interface: 'list',
			options: {
				fields: [
					{
						field: 'body',
						meta: {
							interface: 'input-rich-text-md',
							options: null,
							conditions: [{ name: 'a', rule: {}, options: { folder: 'f-1' } }],
						},
					},
				],
			},
		};

		expect(collect(meta)).toEqual([
			{ path: ['options', 'fields', 0, 'meta', 'conditions', 0, 'options', 'folder'], value: 'f-1' },
		]);
	});

	it('classifies a partial repeater override by the sub-field it overrides', () => {
		const meta = {
			interface: 'list',
			options: {
				fields: [
					{ field: 'title', meta: { interface: 'input' } },
					{ field: 'body', meta: { interface: 'input-rich-text-html', options: { folder: 'f-1' } } },
				],
			},
			conditions: [{ name: 'a', rule: {}, options: { fields: [{}, { meta: { options: { folder: 'f-2' } } }] } }],
		};

		expect(collect(meta)).toEqual([
			{ path: ['options', 'fields', 1, 'meta', 'options', 'folder'], value: 'f-1' },
			{ path: ['conditions', 0, 'options', 'fields', 1, 'meta', 'options', 'folder'], value: 'f-2' },
		]);
	});

	it('does not visit a partial repeater override whose sub-field is outside the registry', () => {
		const meta = {
			interface: 'list',
			options: { fields: [{ field: 'upload', meta: { interface: 'custom-upload' } }] },
			conditions: [{ name: 'a', rule: {}, options: { fields: [{ meta: { options: { folder: 'f-1' } } }] } }],
		};

		expect(collect(meta)).toEqual([]);
	});

	it('does not visit an option named folder on an interface outside the registry', () => {
		expect(collect({ interface: 'custom-upload', options: { folder: 'f-1' } })).toEqual([]);
		expect(collect({ interface: 'constructor', options: { folder: 'f-1' } })).toEqual([]);

		expect(
			collect({
				interface: 'list',
				options: { fields: [{ meta: { interface: 'custom-upload', options: { folder: 'f-1' } } }] },
			})
		).toEqual([]);
	});

	it('skips empty and malformed shapes without throwing', () => {
		expect(collect({})).toEqual([]);
		expect(collect({ interface: 'file', options: { folder: null } })).toEqual([]);
		expect(collect({ interface: 'file', options: '{"folder":"f-1"}' })).toEqual([]);
		expect(collect({ interface: 'list', options: { fields: 'none' } })).toEqual([]);
		expect(collect({ interface: 'list', options: { fields: [null, { field: 'x' }, { meta: 'none' }] } })).toEqual([]);
		expect(collect({ interface: 'file', conditions: 'none' })).toEqual([]);
		expect(collect({ interface: 'file', conditions: [null, { options: null }] })).toEqual([]);
	});
});

describe('parseJsonColumn', () => {
	it('decodes JSON text and passes decoded values through', () => {
		expect(parseJsonColumn('{"folder":"f-1"}')).toEqual({ folder: 'f-1' });
		expect(parseJsonColumn('[{"name":"a"}]')).toEqual([{ name: 'a' }]);
		expect(parseJsonColumn({ folder: 'f-1' })).toEqual({ folder: 'f-1' });
		expect(parseJsonColumn(null)).toBeNull();
	});

	it('returns undefined for text that is not JSON', () => {
		expect(parseJsonColumn('not json')).toBeUndefined();
	});
});
