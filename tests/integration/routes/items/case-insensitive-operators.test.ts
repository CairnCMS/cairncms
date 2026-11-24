import { describe, expect, inject } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { CreateItem, requestGraphQL, setupRequest } from '../../fixtures/request';
import { CreateCollection, CreateField, CreateFieldO2M, CreateRole } from '../../fixtures/schema';
import { familyOf, isMysqlFamily } from '../../harness/database-vendors.mjs';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const vendor = inject('integration').vendor;

const CODES = 'case_insensitive_codes';
const ENTRIES = 'case_insensitive_entries';
const PARENTS = 'case_insensitive_parents';
const CHILDREN = 'case_insensitive_children';
const ADMIN = `Bearer ${USER.ADMIN!.TOKEN}`;
const UNRESOLVED = '$NOW(not a duration)';
const ECOLE = `${String.fromCodePoint(0xc9)}cole`;
const E_ACUTE = String.fromCodePoint(0xe9);
const NUL = String.fromCharCode(0);

const VALIDATOR = 'CaseInsensitiveValidator';
const TENANT_A = 'CaseInsensitiveTenantA';
const TENANT_B = 'CaseInsensitiveTenantB';
const TENANT_NULL = 'CaseInsensitiveTenantNull';
const TENANT_EMPTY = 'CaseInsensitiveTenantEmpty';
const EXCLUDER_A = 'CaseInsensitiveExcluderA';
const EXCLUDER_NULL = 'CaseInsensitiveExcluderNull';
const EXCLUDER_EMPTY = 'CaseInsensitiveExcluderEmpty';
const LITERAL_READER = 'CaseInsensitiveLiteralReader';
const ACCENT_EXCLUDER = 'CaseInsensitiveAccentExcluder';
const UNRESOLVED_DIRECT = 'CaseInsensitiveUnresolvedDirect';
const UNRESOLVED_NEGATED = 'CaseInsensitiveUnresolvedNegated';
const UNRESOLVED_RELATIONAL = 'CaseInsensitiveUnresolvedRelational';
const NONE_EXCLUDER = 'CaseInsensitiveNoneExcluder';

const OPERATORS = ['_istarts_with', '_nistarts_with', '_iends_with', '_niends_with'];

const ROWS: Record<string, string[]> = {
	tenant: ['Tenant-A-1', 'tenant-a-2', 'TENANT-B-1', 'tenant-b-2'],
	wildcard: ['team_a1', 'teamXa1', '1team_a', '1teamXa', '50%off', '500off', 'a!b1', 'a!!b1', 'aXb1'],
	literal: ['true-blue', 'TRUE-red', 'untrue', 'null-row', 'NULL-ROW'],
	turkish: ['Istanbul-1', 'istanbul-2', 'Xstanbul-1'],
	fixed: ['ABC', 'abd', 'XYC'],
	accent: ['\u00c9cole-1', 'Xcole-1', 'caf\u00e9', 'cafx'],
};

const NUL_ROWS: [string, string | null][] = [
	['n1', 'note\u0000tail'],
	['n2', 'Note\u0000TAIL'],
	['n3', 'Note'],
	['n4', 'xnote'],
	['n5', 'no'],
	['n6', null],
];

const BLANK_ROWS: [string, string | null][] = [
	['text', 'Ab1'],
	['other', 'xy'],
	['empty', ''],
	['null', null],
];

const PARENT_ROWS: [string, string[]][] = [
	['mixed', ['Tenant-A-1', 'other-1']],
	['b', ['tenant-b-2']],
	['empty-text', ['']],
	['childless', []],
];

const VALIDATION = [
	{
		field: 'istarts',
		passing: 'ABCdef',
		failing: 'xabc',
		type: 'istarts_with',
		sentence: 'Value has to start with the required text.',
	},
	{
		field: 'nistarts',
		passing: 'xabc',
		failing: 'ABCdef',
		type: 'nistarts_with',
		sentence: `Value can't start with the excluded text.`,
	},
	{
		field: 'iends',
		passing: 'xyzABC',
		failing: 'abcx',
		type: 'iends_with',
		sentence: 'Value has to end with the required text.',
	},
	{
		field: 'niends',
		passing: 'abcx',
		failing: 'xyzAbC',
		type: 'niends_with',
		sentence: `Value can't end with the excluded text.`,
	},
	{
		field: 'icontains',
		passing: 'xABCx',
		failing: 'xabx',
		type: 'contains',
		sentence: 'Value has to contain the required text.',
	},
	{
		field: 'literal',
		passing: 'TRUE-x',
		failing: 'false',
		type: 'istarts_with',
		sentence: 'Value has to start with the required text.',
	},
];

let markerCount = 0;

function marker() {
	markerCount += 1;
	return `entry_${markerCount}`;
}

const test = createIdentityTest().extend<{ scenarioState: Prerequisite<void>; scenario: void }>({
	scenarioState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					const asAdmin = (method: 'post' | 'patch', path: string, body: Record<string, unknown>) =>
						setupRequest(api.url)[method](path).set('Authorization', ADMIN).send(body).expect(200);

					await CreateCollection(api, {
						collection: CODES,
						fields: [
							{ field: 'code', type: 'string' },
							{ field: 'kind', type: 'string' },
							{ field: 'label', type: 'string' },
							{ field: 'span', type: 'string' },
							{ field: 'data', type: 'binary' },
						],
					});

					if (familyOf(vendor) === 'postgres') {
						await api.database.raw('ALTER TABLE ?? ALTER COLUMN ?? TYPE interval USING ??::interval', [
							CODES,
							'span',
							'span',
						]);

						await api.database.raw('ALTER TABLE ?? ADD COLUMN ?? text COLLATE "C"', [CODES, 'ccode']);
						await api.database.raw('ALTER TABLE ?? ADD COLUMN ?? char(5)', [CODES, 'fixed']);

						if (vendor === 'postgres18') {
							await api.database.raw(
								`CREATE COLLATION case_insensitive_level2 (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`
							);

							await api.database.raw('ALTER TABLE ?? ADD COLUMN ?? text COLLATE case_insensitive_level2', [
								CODES,
								'ncode',
							]);
						}
					}

					if (isMysqlFamily(vendor)) {
						for (const [column, collation] of [
							['trcode', 'utf8mb4_turkish_ci'],
							['aicode', 'utf8mb4_general_ci'],
						]) {
							await api.database.raw(
								`ALTER TABLE ?? ADD COLUMN ?? varchar(255) CHARACTER SET utf8mb4 COLLATE ${collation}`,
								[CODES, column]
							);
						}

						await api.database.raw('ALTER TABLE ?? ADD COLUMN ?? char(5)', [CODES, 'fixed']);
					}

					if (familyOf(vendor) !== 'sqlite') {
						await setupRequest(api.url).post('/utils/cache/clear').set('Authorization', ADMIN).expect(200);
					}

					await CreateCollection(api, {
						collection: ENTRIES,
						fields: ['marker', 'code', ...VALIDATION.map((rule) => rule.field)].map((field) => ({
							field,
							type: 'string',
						})),
					});

					await CreateField(api, { collection: 'directus_users', field: 'prefix', type: 'string' });

					for (const [kind, codes] of Object.entries(ROWS)) {
						for (const code of codes) await CreateItem(api, { collection: CODES, item: { code, kind } });
					}

					for (const [label, code] of BLANK_ROWS) {
						await CreateItem(api, { collection: CODES, item: { code, kind: 'blank', label } });
					}

					const blanks = await api
						.database(CODES)
						.where({ kind: 'blank' })
						.whereIn('label', ['empty', 'null'])
						.orderBy('label')
						.select('label', 'code');

					expect(blanks).toEqual([
						{ label: 'empty', code: '' },
						{ label: 'null', code: null },
					]);

					const copyCode = (column: string, kind: string) =>
						api
							.database(CODES)
							.where({ kind })
							.update({ [column]: api.database.ref('code') });

					if (familyOf(vendor) === 'postgres') {
						await copyCode('ccode', 'accent');
						await copyCode('fixed', 'fixed');
						if (vendor === 'postgres18') await copyCode('ncode', 'accent');
					}

					if (isMysqlFamily(vendor)) {
						await copyCode('trcode', 'turkish');
						await copyCode('aicode', 'accent');
						await copyCode('fixed', 'fixed');
					}

					if (familyOf(vendor) === 'sqlite') {
						for (const [label, code] of NUL_ROWS) {
							await CreateItem(api, { collection: CODES, item: { code, kind: 'nul', label } });
						}

						const stored = await api
							.database(CODES)
							.where({ kind: 'nul', label: 'n1' })
							.first(api.database.raw('length(CAST(code AS BLOB)) AS bytes'));

						expect(Number(stored.bytes)).toBe(9);
					}

					await CreateCollection(api, { collection: PARENTS, fields: [{ field: 'name', type: 'string' }] });
					await CreateCollection(api, { collection: CHILDREN, fields: [{ field: 'code', type: 'string' }] });

					await CreateFieldO2M(api, {
						collection: PARENTS,
						field: 'children',
						otherCollection: CHILDREN,
						otherField: 'parent',
					});

					for (const [name, children] of PARENT_ROWS) {
						const parent = await CreateItem(api, { collection: PARENTS, item: { name } });

						for (const code of children) {
							await CreateItem(api, { collection: CHILDREN, item: { code, parent: parent.id } });
						}
					}

					const role = async (name: string) =>
						(await CreateRole(api, { name, appAccessEnabled: false, adminAccessEnabled: false })).id;

					const validator = await role('case_insensitive_validator');
					const tenant = await role('case_insensitive_tenant');
					const excluder = await role('case_insensitive_excluder');
					const literal = await role('case_insensitive_literal');
					const accentExcluder = await role('case_insensitive_accent_excluder');
					const unresolvedDirect = await role('case_insensitive_unresolved_direct');
					const unresolvedNegated = await role('case_insensitive_unresolved_negated');
					const unresolvedRelational = await role('case_insensitive_unresolved_relational');
					const noneExcluder = await role('case_insensitive_none_excluder');

					for (const [readRole, collection, permissions] of [
						[accentExcluder, CODES, { _and: [{ kind: { _eq: 'accent' } }, { code: { _nistarts_with: ECOLE } }] }],
						[unresolvedDirect, CODES, { code: { _istarts_with: UNRESOLVED } }],
						[
							unresolvedNegated,
							CODES,
							{ _and: [{ kind: { _eq: 'tenant' } }, { code: { _nistarts_with: UNRESOLVED } }] },
						],
						[unresolvedRelational, PARENTS, { children: { _none: { code: { _istarts_with: UNRESOLVED } } } }],
						[noneExcluder, PARENTS, { children: { _none: { code: { _nistarts_with: 'tenant' } } } }],
					] as const) {
						await asAdmin('post', '/permissions', {
							role: readRole,
							collection,
							action: 'read',
							fields: collection === CODES ? ['code'] : ['name'],
							permissions,
						});
					}

					for (const action of ['create', 'update']) {
						await asAdmin('post', '/permissions', {
							role: validator,
							collection: ENTRIES,
							action,
							fields: ['*'],
							permissions: {},
							validation: {
								_and: [
									{ istarts: { _istarts_with: 'abc' } },
									{ nistarts: { _nistarts_with: 'abc' } },
									{ iends: { _iends_with: 'abc' } },
									{ niends: { _niends_with: 'abc' } },
									{ icontains: { _icontains: 'abc' } },
									{ literal: { _istarts_with: 'true' } },
								],
							},
						});
					}

					await asAdmin('post', '/permissions', {
						role: validator,
						collection: ENTRIES,
						action: 'read',
						fields: ['id'],
						permissions: {},
					});

					await asAdmin('post', '/permissions', {
						role: tenant,
						collection: ENTRIES,
						action: 'create',
						fields: ['*'],
						validation: { code: { _istarts_with: '$CURRENT_USER.prefix' } },
					});

					await asAdmin('post', '/permissions', {
						role: tenant,
						collection: CODES,
						action: 'read',
						fields: ['code'],
						permissions: { code: { _istarts_with: '$CURRENT_USER.prefix' } },
					});

					await asAdmin('post', '/permissions', {
						role: excluder,
						collection: CODES,
						action: 'read',
						fields: ['code'],
						permissions: { _and: [{ kind: { _eq: 'tenant' } }, { code: { _nistarts_with: '$CURRENT_USER.prefix' } }] },
					});

					await asAdmin('post', '/permissions', {
						role: literal,
						collection: CODES,
						action: 'read',
						fields: ['code'],
						permissions: { code: { _istarts_with: 'null' } },
					});

					for (const [token, userRole, prefix] of [
						[VALIDATOR, validator, null],
						[TENANT_A, tenant, 'tenant-a'],
						[TENANT_B, tenant, 'tenant-b'],
						[TENANT_NULL, tenant, null],
						[TENANT_EMPTY, tenant, ''],
						[EXCLUDER_A, excluder, 'tenant-a'],
						[EXCLUDER_NULL, excluder, null],
						[EXCLUDER_EMPTY, excluder, ''],
						[LITERAL_READER, literal, null],
						[ACCENT_EXCLUDER, accentExcluder, null],
						[UNRESOLVED_DIRECT, unresolvedDirect, null],
						[UNRESOLVED_NEGATED, unresolvedNegated, null],
						[UNRESOLVED_RELATIONAL, unresolvedRelational, null],
						[NONE_EXCLUDER, noneExcluder, null],
					] as const) {
						await asAdmin('post', '/users', {
							email: `${token.toLowerCase()}@example.com`,
							token,
							role: userRole,
							prefix,
						});
					}

					const stored = await api
						.database('directus_users')
						.whereIn(
							'email',
							[TENANT_NULL, TENANT_EMPTY].map((token) => `${token.toLowerCase()}@example.com`)
						)
						.orderBy('email')
						.select('prefix');

					expect(stored).toEqual([{ prefix: '' }, { prefix: null }]);

					await ready();
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	scenario: [
		async ({ api, identities, scenarioState, task, skip }, use) => {
			void api;
			void identities;
			await use(requirePrerequisite(scenarioState, 'case-insensitive operators scenario', { task, skip }));
		},
		{ auto: true },
	],
});

function codes(items: { code: string }[]) {
	return items.map((item) => item.code).sort();
}

function sorted(values: string[]) {
	return [...values].sort();
}

function readCodes(api: Api, token: string, filter?: Record<string, unknown>) {
	const query: Record<string, string> = { fields: 'code', limit: '-1' };
	if (filter) query['filter'] = JSON.stringify(filter);
	return request(api.url).get(`/items/${CODES}`).query(query).set('Authorization', `Bearer ${token}`);
}

function ofKind(kind: string, rule: Record<string, unknown>) {
	return { _and: [{ kind: { _eq: kind } }, { code: rule }] };
}

function invalidQuery(message: string) {
	return [{ message, extensions: { code: 'INVALID_QUERY' } }];
}

function failedValidation(field: string, type: string, sentence: string) {
	return {
		message: `Validation failed for field "${field}". ${sentence}`,
		extensions: { code: 'FAILED_VALIDATION', field, type },
	};
}

function graphqlAs(api: Api, token: string, mutation: string) {
	return request(api.url)
		.post('/graphql')
		.set('Authorization', `Bearer ${token}`)
		.send({ query: `mutation { ${mutation} }` });
}

function graphqlFailedValidation(mutation: string, rule: { field: string; type: string; sentence: string }) {
	return {
		...failedValidation(rule.field, rule.type, rule.sentence),
		locations: [{ line: 1, column: 12 }],
		path: [mutation],
	};
}

async function expectEntry(api: Api, entryMarker: string, count: number) {
	expect(await api.database(ENTRIES).where({ marker: entryMarker }).select('id')).toHaveLength(count);
}

const QUERIES: [string, string, Record<string, unknown>, string[]][] = [
	['_istarts_with', 'tenant', { _istarts_with: 'tenant-a' }, ['Tenant-A-1', 'tenant-a-2']],
	['_nistarts_with', 'tenant', { _nistarts_with: 'TENANT-A' }, ['TENANT-B-1', 'tenant-b-2']],
	['_iends_with', 'tenant', { _iends_with: '-a-1' }, ['Tenant-A-1']],
	['_niends_with', 'tenant', { _niends_with: '-A-1' }, ['TENANT-B-1', 'tenant-a-2', 'tenant-b-2']],
	['_istarts_with', 'wildcard', { _istarts_with: 'TEAM_A' }, ['team_a1']],
	[
		'_nistarts_with',
		'wildcard',
		{ _nistarts_with: 'team_a' },
		['1team_a', '1teamXa', '500off', '50%off', 'teamXa1', 'a!b1', 'a!!b1', 'aXb1'],
	],
	['_iends_with', 'wildcard', { _iends_with: 'TEAM_A' }, ['1team_a']],
	[
		'_niends_with',
		'wildcard',
		{ _niends_with: 'team_a' },
		['1teamXa', '500off', '50%off', 'teamXa1', 'team_a1', 'a!b1', 'a!!b1', 'aXb1'],
	],
	['_istarts_with', 'wildcard', { _istarts_with: '50%' }, ['50%off']],
	['_istarts_with', 'wildcard', { _istarts_with: 'A!B' }, ['a!b1']],
	['_iends_with', 'wildcard', { _iends_with: '!B1' }, ['a!b1', 'a!!b1']],
	['_istarts_with', 'literal', { _istarts_with: 'true' }, ['TRUE-red', 'true-blue']],
	['_istarts_with', 'accent', { _istarts_with: ECOLE }, [`${ECOLE}-1`]],
	['_nistarts_with', 'accent', { _nistarts_with: ECOLE }, ['Xcole-1', `caf${E_ACUTE}`, 'cafx']],
	['_iends_with', 'accent', { _iends_with: E_ACUTE }, [`caf${E_ACUTE}`]],
	['_niends_with', 'accent', { _niends_with: E_ACUTE }, [`${ECOLE}-1`, 'Xcole-1', 'cafx']],
];

describe('Case-insensitive starts and ends operators in queries', () => {
	for (const [operator, kind, rule, expected] of QUERIES) {
		test(`${operator} ${JSON.stringify(rule[operator])} on the ${kind} rows over REST`, async ({ api }) => {
			const response = await readCodes(api, USER.ADMIN!.TOKEN, ofKind(kind, rule));

			expect(response.statusCode).toBe(200);
			expect(codes(response.body.data)).toEqual(sorted(expected));
		});

		test(`${operator} ${JSON.stringify(rule[operator])} on the ${kind} rows over GraphQL`, async ({ api }) => {
			const response = await requestGraphQL(api.url, false, USER.ADMIN!.TOKEN, {
				query: { [CODES]: { __args: { filter: ofKind(kind, rule), limit: -1 }, code: true } },
			});

			expect(response.statusCode).toBe(200);
			expect(codes(response.body.data[CODES])).toEqual(sorted(expected));
		});
	}

	test('_istarts_with keeps the text true in bracket notation', async ({ api }) => {
		const response = await request(api.url)
			.get(`/items/${CODES}`)
			.query('filter[kind][_eq]=literal&filter[code][_istarts_with]=true&fields=code')
			.set('Authorization', ADMIN);

		expect(response.statusCode).toBe(200);
		expect(codes(response.body.data)).toEqual(sorted(['TRUE-red', 'true-blue']));
	});

	for (const operator of OPERATORS) {
		test(`${operator} rejects an empty operand`, async ({ api }) => {
			const response = await readCodes(api, USER.ADMIN!.TOKEN, { code: { [operator]: '' } });

			expect(response.statusCode).toBe(400);
			expect(response.body.errors[0].extensions.code).toBe('INVALID_QUERY');
		});
	}
});

describe('Case-insensitive starts and ends operators in stored read rules', () => {
	test('show each tenant only its own rows, in any case', async ({ api }) => {
		const a = await readCodes(api, TENANT_A);
		const b = await readCodes(api, TENANT_B);

		expect(a.statusCode).toBe(200);
		expect(codes(a.body.data)).toEqual(sorted(['Tenant-A-1', 'tenant-a-2']));
		expect(b.statusCode).toBe(200);
		expect(codes(b.body.data)).toEqual(sorted(['TENANT-B-1', 'tenant-b-2']));
	});

	test('show an excluding role every tenant row but its own', async ({ api }) => {
		const response = await readCodes(api, EXCLUDER_A);

		expect(response.statusCode).toBe(200);
		expect(codes(response.body.data)).toEqual(sorted(['TENANT-B-1', 'tenant-b-2']));
	});

	for (const [label, token, operator] of [
		['a null prefix', TENANT_NULL, '_istarts_with'],
		['an empty prefix', TENANT_EMPTY, '_istarts_with'],
		['a null prefix', EXCLUDER_NULL, '_nistarts_with'],
		['an empty prefix', EXCLUDER_EMPTY, '_nistarts_with'],
	] as const) {
		test(`reject a ${operator} read rule with ${label}`, async ({ api }) => {
			const response = await readCodes(api, token);

			expect(response.statusCode).toBe(400);

			expect(response.body.errors).toEqual(
				invalidQuery(`The filter value for "${operator}" has to be a non-empty string`)
			);
		});
	}

	test('keep the text null as text', async ({ api }) => {
		const response = await readCodes(api, LITERAL_READER);

		expect(response.statusCode).toBe(200);
		expect(codes(response.body.data)).toEqual(sorted(['NULL-ROW', 'null-row']));
	});

	test('leave out the rows an accented prefix excludes', async ({ api }) => {
		const response = await readCodes(api, ACCENT_EXCLUDER);

		expect(response.statusCode).toBe(200);
		expect(codes(response.body.data)).toEqual(sorted(['Xcole-1', `caf${E_ACUTE}`, 'cafx']));
	});

	for (const [label, token, operator] of [
		['a rule', UNRESOLVED_DIRECT, '_istarts_with'],
		['a negated rule inside _and', UNRESOLVED_NEGATED, '_nistarts_with'],
	] as const) {
		test(`reject ${label} whose dynamic value resolves to nothing, over REST and GraphQL`, async ({ api }) => {
			const expected = invalidQuery(`The filter value for "${operator}" has to be a non-empty string`);
			const rest = await readCodes(api, token);

			expect(rest.statusCode).toBe(400);
			expect(rest.body.errors).toEqual(expected);

			const graphql = await requestGraphQL(api.url, false, token, {
				query: { [CODES]: { __args: { limit: -1 }, code: true } },
			});

			expect(graphql.body.data?.[CODES] ?? null).toBeNull();

			expect(
				graphql.body.errors.map((error: { message: string; extensions: unknown }) => ({
					message: error.message,
					extensions: error.extensions,
				}))
			).toEqual(expected);
		});
	}

	test('reject a relational rule whose dynamic value resolves to nothing, over REST and GraphQL', async ({ api }) => {
		const expected = invalidQuery('The filter value for "_istarts_with" has to be a non-empty string');

		const rest = await request(api.url)
			.get(`/items/${PARENTS}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${UNRESOLVED_RELATIONAL}`);

		expect(rest.statusCode).toBe(400);
		expect(rest.body.errors).toEqual(expected);

		const graphql = await requestGraphQL(api.url, false, UNRESOLVED_RELATIONAL, {
			query: { [PARENTS]: { name: true } },
		});

		expect(graphql.body.data?.[PARENTS] ?? null).toBeNull();

		expect(
			graphql.body.errors.map((error: { message: string; extensions: unknown }) => ({
				message: error.message,
				extensions: error.extensions,
			}))
		).toEqual(expected);
	});

	test('apply a tenant rule when the whole GraphQL filter variable is left out', async ({ api }) => {
		const response = await request(api.url)
			.post('/graphql')
			.set('Authorization', `Bearer ${TENANT_A}`)
			.send({ query: `query ($filter: ${CODES}_filter) { ${CODES}(filter: $filter) { code } }` });

		expect(response.body.errors).toBeUndefined();
		expect(codes(response.body.data[CODES])).toEqual(sorted(['Tenant-A-1', 'tenant-a-2']));
	});

	for (const operator of ['_starts_with', '_istarts_with']) {
		test(`refuse a tenant's ${operator} filter whose GraphQL variable is left out`, async ({ api }) => {
			const response = await request(api.url)
				.post('/graphql')
				.set('Authorization', `Bearer ${TENANT_A}`)
				.send({ query: `query ($prefix: String) { ${CODES}(filter: { code: { ${operator}: $prefix } }) { code } }` });

			expect(response.body.data?.[CODES] ?? null).toBeNull();

			expect(
				response.body.errors.map((error: { message: string; extensions: unknown }) => ({
					message: error.message,
					extensions: error.extensions,
				}))
			).toEqual(invalidQuery(`The filter value for "${operator}" has to be a string, number, or boolean`));
		});
	}
});

describe('Case-insensitive starts and ends operators across a relation', () => {
	for (const [label, filter, expected] of [
		['_some with _istarts_with', { _some: { code: { _istarts_with: 'TENANT-A' } } }, ['mixed']],
		['_none with _istarts_with', { _none: { code: { _istarts_with: 'TENANT-A' } } }, ['b', 'childless', 'empty-text']],
		['_some with _nistarts_with', { _some: { code: { _nistarts_with: 'tenant-a' } } }, ['b', 'empty-text', 'mixed']],
		['_none with _niends_with', { _none: { code: { _niends_with: '-2' } } }, ['b', 'childless']],
		['_some with _iends_with', { _some: { code: { _iends_with: '-2' } } }, ['b']],
	] as const) {
		test(`return exactly the parents matching ${label}`, async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${PARENTS}`)
				.query({ fields: 'name', filter: JSON.stringify({ children: filter }) })
				.set('Authorization', ADMIN);

			expect(response.statusCode).toBe(200);
			expect(response.body.data.map((item: { name: string }) => item.name).sort()).toEqual(sorted([...expected]));
		});
	}

	test('hide a parent whose empty child fails a stored _none rule, over REST and GraphQL', async ({ api }) => {
		const rest = await request(api.url)
			.get(`/items/${PARENTS}`)
			.query({ fields: 'name' })
			.set('Authorization', `Bearer ${NONE_EXCLUDER}`);

		expect(rest.statusCode).toBe(200);
		expect(rest.body.data.map((item: { name: string }) => item.name).sort()).toEqual(['b', 'childless']);

		const graphql = await requestGraphQL(api.url, false, NONE_EXCLUDER, { query: { [PARENTS]: { name: true } } });

		expect(graphql.statusCode).toBe(200);
		expect(graphql.body.data[PARENTS].map((item: { name: string }) => item.name).sort()).toEqual(['b', 'childless']);
	});
});

describe('Case-insensitive operators on empty text', () => {
	for (const [operator, operand, expected] of [
		['_istarts_with', 'A', ['text']],
		['_nistarts_with', 'A', ['empty', 'other']],
		['_iends_with', 'B1', ['text']],
		['_niends_with', 'B1', ['empty', 'other']],
	] as const) {
		const filter = { _and: [{ kind: { _eq: 'blank' } }, { code: { [operator]: operand } }] };

		test(`${operator} ${JSON.stringify(operand)} keeps empty text apart from null, over REST`, async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${CODES}`)
				.query({ fields: 'label', filter: JSON.stringify(filter) })
				.set('Authorization', ADMIN);

			expect(response.statusCode).toBe(200);
			expect(response.body.data.map((item: { label: string }) => item.label).sort()).toEqual([...expected]);
		});

		test(`${operator} ${JSON.stringify(operand)} keeps empty text apart from null, over GraphQL`, async ({ api }) => {
			const response = await requestGraphQL(api.url, false, USER.ADMIN!.TOKEN, {
				query: { [CODES]: { __args: { filter, limit: -1 }, label: true } },
			});

			expect(response.statusCode).toBe(200);
			expect(response.body.data[CODES].map((item: { label: string }) => item.label).sort()).toEqual([...expected]);
		});
	}
});

describeForVendors(
	'Case-insensitive operators on text containing NUL',
	['sqlite'],
	`SQLite's LIKE stops at NUL, which the comparison has to avoid. PostgreSQL text can't contain NUL.`,
	() => {
		for (const [label, rule, expected] of [
			['_istarts_with note', { _istarts_with: 'note' }, ['n1', 'n2', 'n3']],
			['_nistarts_with note', { _nistarts_with: 'note' }, ['n4', 'n5']],
			['_iends_with note', { _iends_with: 'note' }, ['n3', 'n4']],
			['_niends_with note', { _niends_with: 'note' }, ['n1', 'n2', 'n5']],
			['_iends_with tail', { _iends_with: 'tail' }, ['n1', 'n2']],
			['_istarts_with with a NUL in the value', { _istarts_with: `NOTE${NUL}t` }, ['n1', 'n2']],
		] as const) {
			test(`${label} compares the whole stored value`, async ({ api }) => {
				const response = await request(api.url)
					.get(`/items/${CODES}`)
					.query({ fields: 'label', filter: JSON.stringify({ _and: [{ kind: { _eq: 'nul' } }, { code: rule }] }) })
					.set('Authorization', ADMIN);

				expect(response.statusCode).toBe(200);
				expect(response.body.data.map((item: { label: string }) => item.label).sort()).toEqual([...expected]);
			});
		}
	}
);

type ColumnCase = [column: string, kind: string, operator: string, operand: string, expected: readonly string[]];

function testColumnCases(cases: readonly ColumnCase[]) {
	for (const [column, kind, operator, operand, expected] of cases) {
		test(`${operator} ${JSON.stringify(operand)} on the ${column} column matches its own text`, async ({ api }) => {
			const response = await readCodes(api, USER.ADMIN!.TOKEN, {
				_and: [{ kind: { _eq: kind } }, { [column]: { [operator]: operand } }],
			});

			expect(response.statusCode).toBe(200);
			expect(codes(response.body.data)).toEqual(sorted([...expected]));
		});
	}
}

describeForVendors(
	'Case-insensitive operators on a fixed-width column',
	['postgres', 'mysql', 'maria'],
	'SQLite has no fixed-width character type.',
	() => {
		testColumnCases([
			['fixed', 'fixed', '_iends_with', 'c', ['ABC', 'XYC']],
			['fixed', 'fixed', '_niends_with', 'c', ['abd']],
		]);
	}
);

describeForVendors(
	'Case-insensitive operators on a column with the C collation',
	['postgres'],
	'The C collation is a PostgreSQL column collation.',
	() => {
		testColumnCases([
			['ccode', 'accent', '_istarts_with', ECOLE, [`${ECOLE}-1`]],
			['ccode', 'accent', '_nistarts_with', ECOLE, ['Xcole-1', `caf${E_ACUTE}`, 'cafx']],
		]);
	}
);

describeForVendors(
	'Case-insensitive operators on a nondeterministic collation',
	['postgres18'],
	'PostgreSQL 18 is the supported engine line whose LIKE accepts a nondeterministic collation.',
	() => {
		testColumnCases([
			['ncode', 'accent', '_istarts_with', ECOLE, [`${ECOLE}-1`]],
			['ncode', 'accent', '_nistarts_with', ECOLE, ['Xcole-1', `caf${E_ACUTE}`, 'cafx']],
		]);
	}
);

describeForVendors(
	`Case-insensitive operators under the column's own collation`,
	['mysql', 'maria'],
	'The Turkish and accent-insensitive column collations are MySQL and MariaDB column definitions.',
	() => {
		testColumnCases([
			['trcode', 'turkish', '_istarts_with', 'I', ['Istanbul-1']],
			['trcode', 'turkish', '_istarts_with', 'i', ['istanbul-2']],
			['trcode', 'turkish', '_nistarts_with', 'I', ['Xstanbul-1', 'istanbul-2']],
			['aicode', 'accent', '_istarts_with', 'e', [`${ECOLE}-1`]],
			['aicode', 'accent', '_nistarts_with', 'e', ['Xcole-1', `caf${E_ACUTE}`, 'cafx']],
		]);
	}
);

describe('Case-insensitive operators in validation rules', () => {
	for (const rule of VALIDATION) {
		test(`accept a ${rule.field} value that satisfies its rule, over REST`, async ({ api }) => {
			const entry = marker();

			const response = await request(api.url)
				.post(`/items/${ENTRIES}`)
				.set('Authorization', `Bearer ${VALIDATOR}`)
				.send({ marker: entry, [rule.field]: rule.passing });

			expect([200, 204]).toContain(response.statusCode);
			await expectEntry(api, entry, 1);
		});

		test(`reject a ${rule.field} value that fails its rule, over REST, without the value`, async ({ api }) => {
			const entry = marker();

			const response = await request(api.url)
				.post(`/items/${ENTRIES}`)
				.set('Authorization', `Bearer ${VALIDATOR}`)
				.send({ marker: entry, [rule.field]: rule.failing });

			expect(response.statusCode).toBe(400);
			expect(response.body.errors).toEqual([failedValidation(rule.field, rule.type, rule.sentence)]);
			expect(JSON.stringify(response.body)).not.toContain(rule.failing);
			await expectEntry(api, entry, 0);
		});

		test(`check a ${rule.field} update against its rule, over REST`, async ({ api }) => {
			const created = await CreateItem(api, { collection: ENTRIES, item: { marker: marker() } });

			const update = (value: string) =>
				request(api.url)
					.patch(`/items/${ENTRIES}/${created.id}`)
					.set('Authorization', `Bearer ${VALIDATOR}`)
					.send({ [rule.field]: value });

			expect([200, 204]).toContain((await update(rule.passing)).statusCode);

			const rejected = await update(rule.failing);

			expect(rejected.statusCode).toBe(400);
			expect(rejected.body.errors).toEqual([failedValidation(rule.field, rule.type, rule.sentence)]);
			expect((await api.database(ENTRIES).where({ id: created.id }).first())[rule.field]).toBe(rule.passing);
		});

		test(`check a ${rule.field} create against its rule, over GraphQL`, async ({ api }) => {
			const create = (entry: string, value: string) =>
				graphqlAs(
					api,
					VALIDATOR,
					`create_${ENTRIES}_item(data: { marker: "${entry}", ${rule.field}: "${value}" }) { id }`
				);

			const accepted = marker();
			const created = await create(accepted, rule.passing);

			expect(created.body.errors).toBeUndefined();
			expect(created.body.data[`create_${ENTRIES}_item`].id).toBeDefined();
			expect((await api.database(ENTRIES).where({ marker: accepted }).first())[rule.field]).toBe(rule.passing);

			const rejected = marker();
			const response = await create(rejected, rule.failing);

			expect(response.body.errors).toEqual([graphqlFailedValidation(`create_${ENTRIES}_item`, rule)]);
			await expectEntry(api, rejected, 0);
		});

		test(`check a ${rule.field} update against its rule, over GraphQL`, async ({ api }) => {
			const created = await CreateItem(api, { collection: ENTRIES, item: { marker: marker() } });

			const update = (value: string) =>
				graphqlAs(
					api,
					VALIDATOR,
					`update_${ENTRIES}_item(id: ${created.id}, data: { ${rule.field}: "${value}" }) { id }`
				);

			const accepted = await update(rule.passing);

			expect(accepted.body.errors).toBeUndefined();
			expect(accepted.body.data[`update_${ENTRIES}_item`].id).toBeDefined();

			const rejected = await update(rule.failing);

			expect(rejected.body.errors).toEqual([graphqlFailedValidation(`update_${ENTRIES}_item`, rule)]);
			expect((await api.database(ENTRIES).where({ id: created.id }).first())[rule.field]).toBe(rule.passing);
		});
	}

	for (const [token, own, other] of [
		[TENANT_A, 'TENANT-A-9', 'tenant-b-9'],
		[TENANT_B, 'Tenant-B-9', 'TENANT-A-9'],
	] as const) {
		test(`let ${token} write only its own prefix, in any case`, async ({ api }) => {
			const write = (code: string, entry: string) =>
				request(api.url)
					.post(`/items/${ENTRIES}`)
					.set('Authorization', `Bearer ${token}`)
					.send({ marker: entry, code });

			const accepted = marker();
			expect([200, 204]).toContain((await write(own, accepted)).statusCode);
			await expectEntry(api, accepted, 1);

			const rejected = marker();
			const response = await write(other, rejected);

			expect(response.statusCode).toBe(400);

			expect(response.body.errors).toEqual([
				failedValidation('code', 'istarts_with', 'Value has to start with the required text.'),
			]);

			await expectEntry(api, rejected, 0);
		});
	}

	test('reject a provided value and accept an omitted one when the prefix is null', async ({ api }) => {
		const rejected = marker();

		const response = await request(api.url)
			.post(`/items/${ENTRIES}`)
			.set('Authorization', `Bearer ${TENANT_NULL}`)
			.send({ marker: rejected, code: 'anything' });

		expect(response.statusCode).toBe(400);

		expect(response.body.errors).toEqual([
			failedValidation('code', 'istarts_with', 'Value has to start with the required text.'),
		]);

		await expectEntry(api, rejected, 0);

		const omitted = marker();

		const accepted = await request(api.url)
			.post(`/items/${ENTRIES}`)
			.set('Authorization', `Bearer ${TENANT_NULL}`)
			.send({ marker: omitted });

		expect([200, 204]).toContain(accepted.statusCode);
		await expectEntry(api, omitted, 1);
	});

	test('accept any text when the prefix is empty, which every text starts with', async ({ api }) => {
		const entry = marker();

		const response = await request(api.url)
			.post(`/items/${ENTRIES}`)
			.set('Authorization', `Bearer ${TENANT_EMPTY}`)
			.send({ marker: entry, code: 'anything' });

		expect([200, 204]).toContain(response.statusCode);
		await expectEntry(api, entry, 1);
	});
});

describeForVendors(
	'Case-insensitive operators on a binary column',
	['mysql', 'maria', 'sqlite'],
	'The binary field type creates a blob column on MySQL, MariaDB, and SQLite. PostgreSQL bytea already fails the operator check as an unknown type.',
	() => {
		for (const operator of OPERATORS) {
			test(`${operator} is rejected`, async ({ api }) => {
				const response = await readCodes(api, USER.ADMIN!.TOKEN, { data: { [operator]: 'abc' } });

				expect(response.statusCode).toBe(400);
				expect(response.body.errors).toEqual(invalidQuery(`The "${operator}" filter operator requires a text column`));
			});
		}
	}
);

describeForVendors(
	'Case-insensitive operators on an interval column',
	['postgres'],
	'Only PostgreSQL has an interval column type, which CairnCMS reads as a string field.',
	() => {
		for (const operator of OPERATORS) {
			test(`${operator} is rejected`, async ({ api }) => {
				const response = await readCodes(api, USER.ADMIN!.TOKEN, { span: { [operator]: 'abc' } });

				expect(response.statusCode).toBe(400);
				expect(response.body.errors).toEqual(invalidQuery(`The "${operator}" filter operator requires a text column`));
			});
		}
	}
);
