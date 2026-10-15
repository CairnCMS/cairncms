import argon2 from 'argon2';
import { parse } from 'graphql';
import type { Knex } from 'knex';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist/services/graphql/index.js');
const describeIfBuilt = existsSync(distPath) ? describe : describe.skip;

const anonymous = { user: null, role: null, admin: false, app: false, ip: '127.0.0.1' };
const nonAdmin = { user: 'user-id', role: 'role-id', admin: false, app: true, ip: '127.0.0.1' };
const admin = { user: 'admin-id', role: 'admin-role-id', admin: true, app: true, ip: '127.0.0.1' };

function field(name: string, type: string): Record<string, unknown> {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: null,
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: false,
	};
}

function collection(name: string): Record<string, unknown> {
	return {
		collection: name,
		primary: 'id',
		singleton: false,
		sortField: null,
		note: null,
		accountability: null,
		fields: { id: field('id', 'integer'), title: field('title', 'string') },
	};
}

const schema = {
	collections: Object.fromEntries(
		['directus_collections', 'directus_fields', 'directus_relations'].map((name) => [name, collection(name)])
	),
	relations: [],
};

const knex = {} as Knex;

const GENERATE = 'mutation ($string: String!) { utils_hash_generate(string: $string) }';
const VERIFY = 'mutation ($string: String!, $hash: String!) { utils_hash_verify(string: $string, hash: $hash) }';

describeIfBuilt('GraphQL hash utilities (production-realm dist probe)', () => {
	const { GraphQLService } = require(distPath);

	function run(accountability: Record<string, unknown>, source: string, variables: Record<string, unknown>) {
		const service = new GraphQLService({ accountability, knex, schema, scope: 'system' });

		return service.execute({ query: null, variables, operationName: null, document: parse(source), contextValue: {} });
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe.each([
		['anonymous', anonymous],
		['non-admin', nonAdmin],
	])('%s caller', (_label, accountability) => {
		it('is forbidden from generating a hash and runs no hashing', async () => {
			const hashSpy = vi.spyOn(argon2, 'hash');

			const result = await run(accountability, GENERATE, { string: 'correct-string' });

			expect(result.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
			expect(hashSpy).not.toHaveBeenCalled();
		});

		it('is forbidden from verifying a hash and runs no verification', async () => {
			const hash = await argon2.hash('correct-string');
			const verifySpy = vi.spyOn(argon2, 'verify');

			const result = await run(accountability, VERIFY, { string: 'correct-string', hash });

			expect(result.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
			expect(verifySpy).not.toHaveBeenCalled();
		});
	});

	it('runs hashing and verification for an admin', async () => {
		const hashSpy = vi.spyOn(argon2, 'hash');
		const verifySpy = vi.spyOn(argon2, 'verify');

		const generated = await run(admin, GENERATE, { string: 'correct-string' });
		const verified = await run(admin, VERIFY, { string: 'correct-string', hash: generated.data?.utils_hash_generate });

		expect(verified.data).toEqual({ utils_hash_verify: true });
		expect(hashSpy).toHaveBeenCalledOnce();
		expect(verifySpy).toHaveBeenCalledOnce();
	});
});
