import { FailedValidationException } from '@cairncms/exceptions';
import { ForbiddenException } from '../exceptions/index.js';
import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationService } from './authorization.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

const testSchema = {
	collections: {
		directus_users: {
			collection: 'directus_users',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: {
					field: 'id',
					defaultValue: null,
					nullable: true,
					generated: true,
					type: 'uuid',
					dbType: 'uuid',
					precision: null,
					scale: null,
					special: [],
					note: null,
					validation: null,
					alias: false,
				},
				role: {
					field: 'role',
					defaultValue: null,
					nullable: true,
					generated: false,
					type: 'uuid',
					dbType: 'uuid',
					precision: null,
					scale: null,
					special: [],
					note: null,
					validation: null,
					alias: false,
				},
			},
		},
	},
	relations: [],
} as SchemaOverview;

describe('AuthorizationService.validatePayload — _in filter with empty array (GHSA-hxgm-ghmv-xjjm)', () => {
	let db: MockedFunction<Knex>;

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		createTracker(db);
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('throws FailedValidationException when permission validation carries _in [] and the payload would otherwise pass', () => {
		const accountability: Accountability = {
			role: 'restricted-editor-role-uuid',
			user: 'user-uuid',
			admin: false,
			app: true,
			permissions: [
				{
					id: 1,
					role: 'restricted-editor-role-uuid',
					collection: 'directus_users',
					action: 'update',
					permissions: {},
					validation: { role: { _in: [] } },
					presets: {},
					fields: ['*'],
				},
			],
		};

		const service = new AuthorizationService({
			knex: db,
			schema: testSchema,
			accountability,
		});

		let thrown: unknown;

		try {
			service.validatePayload('update', 'directus_users', { role: 'admin-role-uuid' });
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeDefined();
		expect(Array.isArray(thrown)).toBe(true);
		expect((thrown as unknown[]).length).toBeGreaterThan(0);
		expect((thrown as unknown[])[0]).toBeInstanceOf(FailedValidationException);
	});

	it('returns the payload without throwing when permission validation carries _in with a matching value', () => {
		const accountability: Accountability = {
			role: 'restricted-editor-role-uuid',
			user: 'user-uuid',
			admin: false,
			app: true,
			permissions: [
				{
					id: 1,
					role: 'restricted-editor-role-uuid',
					collection: 'directus_users',
					action: 'update',
					permissions: {},
					validation: { role: { _in: ['some-allowed-role-uuid'] } },
					presets: {},
					fields: ['*'],
				},
			],
		};

		const service = new AuthorizationService({
			knex: db,
			schema: testSchema,
			accountability,
		});

		const result = service.validatePayload('update', 'directus_users', {
			role: 'some-allowed-role-uuid',
		});

		expect(result).toStrictEqual({ role: 'some-allowed-role-uuid' });
	});
});

describe('AuthorizationService.processAST — sort operand requires field-read authority', () => {
	let db: MockedFunction<Knex>;

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

	const employeesSchema = {
		collections: {
			employees: {
				collection: 'employees',
				primary: 'id',
				singleton: false,
				sortField: null,
				note: null,
				accountability: null,
				fields: {
					id: makeField('id', 'uuid'),
					name: makeField('name'),
					salary: makeField('salary'),
					company: makeField('company', 'uuid'),
				},
			},
			companies: {
				collection: 'companies',
				primary: 'id',
				singleton: false,
				sortField: null,
				note: null,
				accountability: null,
				fields: {
					id: makeField('id', 'uuid'),
					name: makeField('name'),
					secret_revenue: makeField('secret_revenue'),
				},
			},
		},
		relations: [
			{
				collection: 'employees',
				field: 'company',
				related_collection: 'companies',
				schema: null,
				meta: null,
			},
		],
	} as unknown as SchemaOverview;

	function makeService(fields: string[]): AuthorizationService {
		const accountability: Accountability = {
			user: 'user-uuid',
			role: 'role-uuid',
			admin: false,
			app: true,
			permissions: [
				{
					id: 1,
					role: 'role-uuid',
					collection: 'employees',
					action: 'read',
					permissions: {},
					validation: null,
					presets: null,
					fields,
				},
			],
		};

		return new AuthorizationService({ knex: db, schema: employeesSchema, accountability });
	}

	beforeAll(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		createTracker(db);
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('bug-exposing — sort by unread field is rejected', () => {
		it('throws ForbiddenException for sort on a field not in permission.fields', async () => {
			const service = makeService(['id', 'name']);
			const { default: getASTFromQuery } = await import('../utils/get-ast-from-query.js');

			const ast = await getASTFromQuery('employees', { fields: ['id', 'name'], sort: ['salary'] }, employeesSchema, {
				accountability: service.accountability,
			});

			await expect(service.processAST(ast)).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('throws ForbiddenException for descending sort on unread field', async () => {
			const service = makeService(['id', 'name']);
			const { default: getASTFromQuery } = await import('../utils/get-ast-from-query.js');

			const ast = await getASTFromQuery('employees', { fields: ['id', 'name'], sort: ['-salary'] }, employeesSchema, {
				accountability: service.accountability,
			});

			await expect(service.processAST(ast)).rejects.toBeInstanceOf(ForbiddenException);
		});
	});

	describe('regression — sort by readable field is accepted', () => {
		it('accepts sort on a permitted field', async () => {
			const service = makeService(['id', 'name']);
			const { default: getASTFromQuery } = await import('../utils/get-ast-from-query.js');

			const ast = await getASTFromQuery('employees', { fields: ['id', 'name'], sort: ['name'] }, employeesSchema, {
				accountability: service.accountability,
			});

			await expect(service.processAST(ast)).resolves.toBeDefined();
		});

		it('wildcard permission accepts sort on any field', async () => {
			const service = makeService(['*']);
			const { default: getASTFromQuery } = await import('../utils/get-ast-from-query.js');

			const ast = await getASTFromQuery('employees', { fields: ['*'], sort: ['salary'] }, employeesSchema, {
				accountability: service.accountability,
			});

			await expect(service.processAST(ast)).resolves.toBeDefined();
		});
	});

	describe('bug-exposing — function-wrapped sort on unread field is rejected', () => {
		it('throws ForbiddenException for year(salary) when salary is unread', async () => {
			const service = makeService(['id', 'name']);
			const { default: getASTFromQuery } = await import('../utils/get-ast-from-query.js');

			const ast = await getASTFromQuery(
				'employees',
				{ fields: ['id', 'name'], sort: ['year(salary)'] },
				employeesSchema,
				{ accountability: service.accountability }
			);

			await expect(service.processAST(ast)).rejects.toBeInstanceOf(ForbiddenException);
		});
	});

	describe('bug-exposing — alias sort mapped to an unread real field is rejected', () => {
		it('throws ForbiddenException when alias resolves to an unread field', async () => {
			const service = makeService(['id', 'name']);
			const { default: getASTFromQuery } = await import('../utils/get-ast-from-query.js');

			const ast = await getASTFromQuery(
				'employees',
				{ fields: ['id', 'name'], sort: ['display'], alias: { display: 'salary' } },
				employeesSchema,
				{ accountability: service.accountability }
			);

			await expect(service.processAST(ast)).rejects.toBeInstanceOf(ForbiddenException);
		});
	});

	describe('bug-exposing — group operand on unread field is rejected via AST fields rewrite', () => {
		it('throws ForbiddenException when grouping by an unread field', async () => {
			const service = makeService(['id', 'name']);
			const { default: getASTFromQuery } = await import('../utils/get-ast-from-query.js');

			const ast = await getASTFromQuery(
				'employees',
				{ fields: ['id', 'name'], group: ['salary'], aggregate: { count: ['*'] } },
				employeesSchema,
				{ accountability: service.accountability }
			);

			await expect(service.processAST(ast)).rejects.toBeInstanceOf(ForbiddenException);
		});
	});

	describe('bug-exposing — relational sort by an unread field on the related collection is rejected', () => {
		function makeServiceWithRelatedRead(): AuthorizationService {
			const accountability: Accountability = {
				user: 'user-uuid',
				role: 'role-uuid',
				admin: false,
				app: true,
				permissions: [
					{
						id: 1,
						role: 'role-uuid',
						collection: 'employees',
						action: 'read',
						permissions: {},
						validation: null,
						presets: null,
						fields: ['id', 'name', 'company'],
					},
					{
						id: 2,
						role: 'role-uuid',
						collection: 'companies',
						action: 'read',
						permissions: {},
						validation: null,
						presets: null,
						fields: ['id', 'name'],
					},
				],
			};

			return new AuthorizationService({ knex: db, schema: employeesSchema, accountability });
		}

		it('throws ForbiddenException when sort references a field unread on the related collection', async () => {
			const service = makeServiceWithRelatedRead();
			const { default: getASTFromQuery } = await import('../utils/get-ast-from-query.js');

			const ast = await getASTFromQuery(
				'employees',
				{ fields: ['id', 'name'], sort: ['company.secret_revenue'] },
				employeesSchema,
				{ accountability: service.accountability }
			);

			await expect(service.processAST(ast)).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('accepts sort on a readable field on the related collection (regression)', async () => {
			const service = makeServiceWithRelatedRead();
			const { default: getASTFromQuery } = await import('../utils/get-ast-from-query.js');

			const ast = await getASTFromQuery(
				'employees',
				{ fields: ['id', 'name'], sort: ['company.name'] },
				employeesSchema,
				{ accountability: service.accountability }
			);

			await expect(service.processAST(ast)).resolves.toBeDefined();
		});
	});
});
