import type { SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidPayloadException, UnprocessableEntityException } from '../exceptions/index.js';
import { RolesService } from './roles.js';

vi.mock('../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('sqlite'),
}));

const PUBLIC_ROLE_ID = '00000000-0000-0000-0000-000000000000';
const ADMIN_ROLE_ID = '11111111-1111-4111-8111-111111111111';
const EDITOR_ROLE_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_USER_ID = '33333333-3333-4333-8333-333333333333';

function field(name: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: type,
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: false,
		...extra,
	};
}

const schema = {
	collections: {
		directus_roles: {
			collection: 'directus_roles',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'uuid', { nullable: false, special: ['uuid'] }),
				key: field('key', 'string'),
				name: field('name', 'string'),
				icon: field('icon', 'string'),
				description: field('description', 'text'),
				ip_access: field('ip_access', 'csv', { special: ['cast-csv'] }),
				enforce_tfa: field('enforce_tfa', 'boolean', { special: ['cast-boolean'] }),
				admin_access: field('admin_access', 'boolean', { special: ['cast-boolean'] }),
				app_access: field('app_access', 'boolean', { special: ['cast-boolean'] }),
				users: field('users', 'alias', { special: ['o2m'], alias: true }),
			},
		},
		directus_users: {
			collection: 'directus_users',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'uuid', { nullable: false, special: ['uuid'] }),
				role: field('role', 'uuid'),
				status: field('status', 'string'),
			},
		},
	},
	relations: [
		{
			collection: 'directus_users',
			field: 'role',
			related_collection: 'directus_roles',
			schema: null,
			meta: {
				id: 1,
				many_collection: 'directus_users',
				many_field: 'role',
				one_collection: 'directus_roles',
				one_field: 'users',
				one_collection_field: null,
				one_allowed_collections: null,
				junction_field: null,
				sort_field: null,
				one_deselect_action: 'nullify',
			},
		},
	],
} as unknown as SchemaOverview;

describe('RolesService.upsertMany on a real single-connection SQLite database', () => {
	let db: Knex;

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 500,
		});

		await db.schema.createTable('directus_roles', (table) => {
			table.uuid('id').primary();
			table.string('key').unique();
			table.string('name');
			table.string('icon');
			table.text('description');
			table.text('ip_access');
			table.boolean('enforce_tfa').defaultTo(false);
			table.boolean('admin_access').defaultTo(false);
			table.boolean('app_access').defaultTo(true);
		});

		await db.schema.createTable('directus_users', (table) => {
			table.uuid('id').primary();
			table.uuid('role');
			table.string('status');
		});

		await db('directus_roles').insert([
			{ id: PUBLIC_ROLE_ID, key: 'public', name: 'Public', admin_access: false, app_access: false },
			{ id: ADMIN_ROLE_ID, key: 'administrator', name: 'Administrator', admin_access: true, app_access: true },
			{ id: EDITOR_ROLE_ID, key: 'editor', name: 'Editor', admin_access: false, app_access: true },
		]);

		await db('directus_users').insert({ id: ADMIN_USER_ID, role: ADMIN_ROLE_ID, status: 'active' });
	});

	afterEach(async () => {
		await db.destroy();
	});

	function service(): RolesService {
		return new RolesService({ knex: db, schema });
	}

	async function role(id: string): Promise<Record<string, unknown>> {
		return db('directus_roles').where({ id }).first();
	}

	it('generates a key on create and keeps an existing key immutable', async () => {
		const [created] = await service().upsertMany([{ name: 'Ops Team', admin_access: false, app_access: true }]);

		expect(await role(String(created))).toMatchObject({ key: 'ops_team', name: 'Ops Team' });

		await expect(service().upsertMany([{ id: created, key: 'renamed_key' }])).rejects.toBeInstanceOf(
			InvalidPayloadException
		);

		expect(await role(String(created))).toMatchObject({ key: 'ops_team', name: 'Ops Team' });
	});

	it.each(['admin_access', 'app_access', 'enforce_tfa', 'ip_access', 'users'])(
		'refuses %s on the public role and leaves it unchanged',
		async (protectedField) => {
			const before = await role(PUBLIC_ROLE_ID);

			await expect(
				service().upsertMany([{ id: PUBLIC_ROLE_ID, [protectedField]: protectedField === 'users' ? [] : true }])
			).rejects.toBeInstanceOf(InvalidPayloadException);

			expect(await role(PUBLIC_ROLE_ID)).toEqual(before);
		}
	);

	it('refuses demoting the sole administrator, even after a promotion in the same call, and rolls back', async () => {
		const adminBefore = await role(ADMIN_ROLE_ID);
		const editorBefore = await role(EDITOR_ROLE_ID);

		await expect(
			service().upsertMany([
				{ id: EDITOR_ROLE_ID, admin_access: true },
				{ id: ADMIN_ROLE_ID, admin_access: false },
			])
		).rejects.toBeInstanceOf(UnprocessableEntityException);

		expect(await role(ADMIN_ROLE_ID)).toEqual(adminBefore);
		expect(await role(EDITOR_ROLE_ID)).toEqual(editorBefore);
	});

	it('runs the users check on the transaction, so an existing-role upsert with users completes', async () => {
		await expect(service().upsertMany([{ id: EDITOR_ROLE_ID, name: 'Editors', users: [] }])).resolves.toEqual([
			EDITOR_ROLE_ID,
		]);

		expect(await role(EDITOR_ROLE_ID)).toMatchObject({ name: 'Editors', key: 'editor' });
	}, 10000);

	it('persists a mixed create-and-update batch', async () => {
		const [created, updated] = await service().upsertMany([
			{ name: 'Reviewers', admin_access: false, app_access: true },
			{ id: EDITOR_ROLE_ID, description: 'Edits content' },
		]);

		expect(updated).toBe(EDITOR_ROLE_ID);
		expect(await role(String(created))).toMatchObject({ key: 'reviewers', name: 'Reviewers' });
		expect(await role(EDITOR_ROLE_ID)).toMatchObject({ description: 'Edits content', key: 'editor' });
	});
});
