import { describe, expect, inject } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { CreateItem, requestGraphQL, setupRequest } from '../../fixtures/request';
import { CreateCollection, CreateField, CreateRole } from '../../fixtures/schema';
import { familyOf } from '../../harness/database-vendors.mjs';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const vendor = inject('integration').vendor;

const CODES = 'case_insensitive_codes';
const ENTRIES = 'case_insensitive_entries';
const ADMIN = `Bearer ${USER.ADMIN!.TOKEN}`;

const VALIDATOR = 'CaseInsensitiveValidator';
const TENANT_A = 'CaseInsensitiveTenantA';
const TENANT_B = 'CaseInsensitiveTenantB';
const TENANT_NULL = 'CaseInsensitiveTenantNull';
const TENANT_EMPTY = 'CaseInsensitiveTenantEmpty';
const EXCLUDER_A = 'CaseInsensitiveExcluderA';
const EXCLUDER_NULL = 'CaseInsensitiveExcluderNull';
const EXCLUDER_EMPTY = 'CaseInsensitiveExcluderEmpty';
const LITERAL_READER = 'CaseInsensitiveLiteralReader';

const OPERATORS = ['_istarts_with', '_nistarts_with', '_iends_with', '_niends_with'];

const ROWS: Record<string, string[]> = {
	tenant: ['Tenant-A-1', 'tenant-a-2', 'TENANT-B-1', 'tenant-b-2'],
	wildcard: ['team_a1', 'teamXa1', '1team_a', '1teamXa', '50%off', '500off'],
	literal: ['true-blue', 'TRUE-red', 'untrue', 'null-row', 'NULL-ROW'],
};

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

					const role = async (name: string) =>
						(await CreateRole(api, { name, appAccessEnabled: false, adminAccessEnabled: false })).id;

					const validator = await role('case_insensitive_validator');
					const tenant = await role('case_insensitive_tenant');
					const excluder = await role('case_insensitive_excluder');
					const literal = await role('case_insensitive_literal');

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
	['_nistarts_with', 'wildcard', { _nistarts_with: 'team_a' }, ['1team_a', '1teamXa', '500off', '50%off', 'teamXa1']],
	['_iends_with', 'wildcard', { _iends_with: 'TEAM_A' }, ['1team_a']],
	['_niends_with', 'wildcard', { _niends_with: 'team_a' }, ['1teamXa', '500off', '50%off', 'teamXa1', 'team_a1']],
	['_istarts_with', 'wildcard', { _istarts_with: '50%' }, ['50%off']],
	['_istarts_with', 'literal', { _istarts_with: 'true' }, ['TRUE-red', 'true-blue']],
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
});

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
