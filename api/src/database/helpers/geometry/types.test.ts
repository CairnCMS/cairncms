import type { Knex } from 'knex';
import { describe, expect, it, vi } from 'vitest';
import { InvalidPayloadException } from '../../../exceptions/index.js';
import { mysql, postgres, sqlite } from './index.js';

const subtypes = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'];
const undeclared = ['geometry.NotAType', 'geometry.point', 'geometry.', 'geometry.Point.extra', 'geometryPoint'];

function columnFor(helper: { createColumn: (table: Knex.CreateTableBuilder, field: any) => unknown }, type: string) {
	const specificType = vi.fn();
	helper.createColumn({ specificType } as unknown as Knex.CreateTableBuilder, { field: 'location', type });
	return specificType;
}

describe('PostgreSQL geometry columns', () => {
	const helper = new postgres({} as Knex);

	it('builds plain geometry and every declared subtype', () => {
		expect(columnFor(helper, 'geometry')).toHaveBeenCalledWith('location', 'geometry(geometry, 4326)');

		for (const subtype of subtypes) {
			expect(columnFor(helper, `geometry.${subtype}`)).toHaveBeenCalledWith('location', `geometry(${subtype}, 4326)`);
		}
	});

	it.each(undeclared)('refuses %s without building a column', (type) => {
		const specificType = vi.fn();

		expect(() =>
			helper.createColumn({ specificType } as unknown as Knex.CreateTableBuilder, { field: 'location', type } as never)
		).toThrow(new InvalidPayloadException(`Illegal type passed: "${type}"`));

		expect(specificType).not.toHaveBeenCalled();
	});
});

describe.each([
	['MySQL', mysql],
	['SQLite', sqlite],
])('%s geometry columns', (_name, Helper) => {
	const helper = new Helper({} as Knex);

	it('builds plain geometry and every declared subtype', () => {
		expect(columnFor(helper, 'geometry')).toHaveBeenCalledWith('location', 'geometry');

		for (const subtype of subtypes) {
			expect(columnFor(helper, `geometry.${subtype}`)).toHaveBeenCalledWith('location', subtype);
		}
	});

	it.each(undeclared)('refuses %s without building a column', (type) => {
		const specificType = vi.fn();

		expect(() =>
			helper.createColumn({ specificType } as unknown as Knex.CreateTableBuilder, { field: 'location', type } as never)
		).toThrow(new InvalidPayloadException(`Illegal type passed: "${type}"`));

		expect(specificType).not.toHaveBeenCalled();
	});
});
