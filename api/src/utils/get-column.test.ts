import type { SchemaOverview } from '@cairncms/types';
import knex from 'knex';
import { describe, expect, it } from 'vitest';
import { InvalidQueryException } from '../exceptions/index.js';
import { getColumn } from './get-column.js';

const schema = {
	collections: {
		notes: {
			collection: 'notes',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: { field: 'id', type: 'integer', special: [] },
				created: { field: 'created', type: 'timestamp', special: [] },
			},
		},
	},
	relations: [],
} as unknown as SchemaOverview;

const db = knex.default({ client: 'sqlite3', useNullAsDefault: true });

describe('getColumn', () => {
	it('applies a function to the column it encloses', () => {
		const sql = db.select(getColumn(db, 'notes', 'year(created)', undefined, schema)).toSQL().sql;

		expect(sql).toContain('created');
		expect(sql).toContain('created_year');
	});

	it('returns a plain column reference without a function', () => {
		expect(db.select(getColumn(db, 'notes', 'id', undefined, schema)).toSQL().sql).toContain('`notes`.`id`');
	});

	it.each(['year)(created', ')' + '('.repeat(20_000)])(
		'rejects a function-shaped column that encloses nothing as an invalid query',
		(column) => {
			expect(() => getColumn(db, 'notes', column, undefined, schema)).toThrow(InvalidQueryException);
		}
	);
});
