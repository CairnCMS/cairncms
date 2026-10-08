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

function makeCollection(collection: string, fields: Record<string, any>): any {
	return {
		collection,
		primary: 'id',
		singleton: false,
		sortField: null,
		note: null,
		accountability: null,
		fields: { id: makeField('id', 'uuid'), ...fields },
	};
}

function makeAlias(name: string): any {
	return { ...makeField(name), type: 'alias', alias: true, special: ['o2m'] };
}

function makeStrictSchema(allowedCollections: string[] = ['orgs']): SchemaOverview {
	return {
		collections: {
			directus_users: makeCollection('directus_users', {
				email: makeField('email'),
				birthday: { ...makeField('birthday'), type: 'date' },
				org: makeField('org', 'uuid'),
				role: makeField('role', 'uuid'),
				favorite: makeField('favorite'),
				favorite_collection: makeField('favorite_collection'),
				memberships: makeAlias('memberships'),
			}),
			directus_roles: makeCollection('directus_roles', { name: makeField('name') }),
			orgs: makeCollection('orgs', { name: makeField('name'), blocked_tenant: makeField('blocked_tenant') }),
			teams: makeCollection('teams', { name: makeField('name') }),
			memberships: makeCollection('memberships', {
				user: makeField('user', 'uuid'),
				blocked_tenant: makeField('blocked_tenant'),
			}),
		},
		relations: [
			{ collection: 'directus_users', field: 'org', related_collection: 'orgs', schema: null, meta: null },
			{ collection: 'directus_users', field: 'role', related_collection: 'directus_roles', schema: null, meta: null },
			{
				collection: 'memberships',
				field: 'user',
				related_collection: 'directus_users',
				schema: null,
				meta: { one_field: 'memberships' },
			},
			{
				collection: 'directus_users',
				field: 'favorite',
				related_collection: null,
				schema: null,
				meta: { one_collection_field: 'favorite_collection', one_allowed_collections: allowedCollections },
			},
		],
	} as unknown as SchemaOverview;
}

describe('getASTFromQuery strict mode', () => {
	it.each([
		'email',
		'year(birthday)',
		'org.blocked_tenant',
		'role.name',
		'memberships.blocked_tenant',
		'favorite:orgs.blocked_tenant',
		'favorite.blocked_tenant',
	])('accepts the resolvable path %s', async (path) => {
		await expect(
			getASTFromQuery('directus_users', { fields: [path] }, makeStrictSchema(), { strict: true })
		).resolves.toBeDefined();
	});

	it.each([
		['a missing plain field', 'tenant'],
		['a function over a missing column', 'year(missing)'],
		['a missing relation', 'team.name'],
		['a plain field used as a relation', 'email.domain'],
		['a missing field behind a relation', 'org.missing'],
		['a missing relation below the root', 'org.parent.name'],
		['a missing field behind a reverse alias', 'memberships.missing'],
		['a many-to-any scope that is not allowed', 'favorite:teams.name'],
		['a missing path behind a many-to-any scope', 'favorite:orgs.missing.deep'],
	])('rejects %s', async (_case, path) => {
		await expect(
			getASTFromQuery('directus_users', { fields: [path] }, makeStrictSchema(), { strict: true })
		).rejects.toThrow('Invalid field path');
	});

	it('rejects an unscoped many-to-any path that one allowed collection cannot resolve', async () => {
		await expect(
			getASTFromQuery('directus_users', { fields: ['favorite.blocked_tenant'] }, makeStrictSchema(['orgs', 'teams']), {
				strict: true,
			})
		).rejects.toThrow('Invalid field path');
	});

	it('rejects a many-to-any path with no allowed collections', async () => {
		await expect(
			getASTFromQuery('directus_users', { fields: ['favorite.name'] }, makeStrictSchema([]), { strict: true })
		).rejects.toThrow('Invalid field path');
	});

	it('rejects a relation whose target collection is not in the schema', async () => {
		const schema = makeStrictSchema();
		delete (schema.collections as Record<string, unknown>)['orgs'];

		await expect(
			getASTFromQuery('directus_users', { fields: ['org.blocked_tenant'] }, schema, { strict: true })
		).rejects.toThrow('Invalid field path');
	});

	it('leaves unresolvable paths out without throwing when not strict', async () => {
		const ast = await getASTFromQuery(
			'directus_users',
			{ fields: ['email', 'team.name', 'org.missing'] },
			makeStrictSchema()
		);

		expect(ast.children.map((child) => child.fieldKey)).toEqual(['email', 'org']);
	});

	it('keeps a function-shaped key that encloses nothing as a plain field when not strict', async () => {
		const malformed = ')' + '('.repeat(20_000);

		const ast = await getASTFromQuery('directus_users', { fields: [malformed] }, makeStrictSchema());

		expect(ast.children).toEqual([{ type: 'field', name: malformed, fieldKey: malformed }]);
	});

	it('rejects a function-shaped key that encloses nothing when strict', async () => {
		await expect(
			getASTFromQuery('directus_users', { fields: ['year)(birthday'] }, makeStrictSchema(), { strict: true })
		).rejects.toThrow('Invalid field path');
	});
});
