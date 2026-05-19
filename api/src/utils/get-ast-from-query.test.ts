import type { Accountability, Permission, SchemaOverview } from '@cairncms/types';
import { describe, expect, it, vi } from 'vitest';
import getASTFromQuery from './get-ast-from-query.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('sqlite'),
}));

function makeField(name: string, type: 'string' | 'uuid' = 'string'): any {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: type === 'uuid' ? 'uuid' : 'varchar',
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: false,
	};
}

function makeSchema(sortField: string | null = null): SchemaOverview {
	return {
		collections: {
			employees: {
				collection: 'employees',
				primary: 'id',
				singleton: false,
				sortField,
				note: null,
				accountability: null,
				fields: {
					id: makeField('id', 'uuid'),
					name: makeField('name'),
					salary: makeField('salary'),
				},
			},
		},
		relations: [],
	} as unknown as SchemaOverview;
}

function makePermission(fields: string[] | null): Permission {
	return {
		id: 1,
		role: 'role-uuid',
		collection: 'employees',
		action: 'read',
		permissions: null,
		validation: null,
		presets: null,
		fields,
	};
}

function makeAccountability(overrides: Partial<Accountability> = {}): Accountability {
	return {
		user: 'user-uuid',
		role: 'role-uuid',
		admin: false,
		app: true,
		ip: '127.0.0.1',
		permissions: [makePermission(['id', 'name'])],
		...overrides,
	};
}

describe('getASTFromQuery — default sort normalization for unread schema sortField', () => {
	describe('bug-exposing — implicit default sort silently falls back when sort field is unread', () => {
		it('falls back to primary key when caller cannot read the schema sortField', async () => {
			const ast = await getASTFromQuery('employees', { fields: ['id', 'name'] }, makeSchema('salary'), {
				accountability: makeAccountability({ permissions: [makePermission(['id', 'name'])] }),
			});

			expect(ast.query.sort).toEqual(['id']);
		});
	});

	describe('regression — admin and wildcard preserve the schema sortField default', () => {
		it('admin caller uses the schema sortField default', async () => {
			const ast = await getASTFromQuery('employees', { fields: ['id', 'name'] }, makeSchema('salary'), {
				accountability: makeAccountability({ admin: true }),
			});

			expect(ast.query.sort).toEqual(['salary']);
		});

		it('wildcard fields permission uses the schema sortField default', async () => {
			const ast = await getASTFromQuery('employees', { fields: ['id', 'name'] }, makeSchema('salary'), {
				accountability: makeAccountability({ permissions: [makePermission(['*'])] }),
			});

			expect(ast.query.sort).toEqual(['salary']);
		});

		it('caller with read on the sortField uses it as default', async () => {
			const ast = await getASTFromQuery('employees', { fields: ['id', 'name'] }, makeSchema('name'), {
				accountability: makeAccountability({ permissions: [makePermission(['id', 'name'])] }),
			});

			expect(ast.query.sort).toEqual(['name']);
		});

		it('no schema sortField configured: defaults to primary key', async () => {
			const ast = await getASTFromQuery('employees', { fields: ['id', 'name'] }, makeSchema(null), {
				accountability: makeAccountability(),
			});

			expect(ast.query.sort).toEqual(['id']);
		});
	});

	describe('regression — explicit sort is preserved as-is', () => {
		it('explicit user sort is kept regardless of permissions', async () => {
			const ast = await getASTFromQuery(
				'employees',
				{ fields: ['id', 'name'], sort: ['salary'] },
				makeSchema('salary'),
				{ accountability: makeAccountability({ permissions: [makePermission(['id', 'name'])] }) }
			);

			expect(ast.query.sort).toEqual(['salary']);
		});
	});

	describe('regression — group-derived default sort is not normalized here', () => {
		it('first group column becomes the default sort even when caller cannot read it', async () => {
			const ast = await getASTFromQuery('employees', { fields: ['id', 'name'], group: ['salary'] }, makeSchema(null), {
				accountability: makeAccountability({ permissions: [makePermission(['id', 'name'])] }),
			});

			expect(ast.query.sort).toEqual(['salary']);
		});
	});
});
