import { describe, expect, inject } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { CreateItem, requestGraphQL, setupRequest } from '../../fixtures/request';
import { CreateCollection, CreateRole } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { createWebSocketGql, processGraphQLJson } from '../realtime/transport';

initializeFixtures();

const RECORDS = 'gqlerrors';
const SETTINGS = 'gqlsettings';
const ADMIN_TOKEN = USER.ADMIN!.TOKEN;
const MEMBER = 'GraphQLMutationErrorsMember';
const TENANT_B_NOTE = 'TENANT_B_NOTE_6e3a';
const LOCATION = [{ line: 1, column: 12 }];
const VENDOR = inject('integration').vendor;

const IDENTITIES = [
	['an administrator', ADMIN_TOKEN],
	['a member', MEMBER],
] as const;

type Scenario = { betaId: number; tenantBId: number };

async function graphqlError(api: Api, token: string, field: string, args: Record<string, unknown>) {
	const response = await requestGraphQL(api.url, false, token, { mutation: { [field]: { __args: args, id: true } } });

	expect(response.statusCode).toBe(200);
	expect(response.body.errors).toHaveLength(1);
	return response.body.errors[0];
}

async function restError(api: Api, token: string, method: 'post' | 'patch', path: string, body: string | object) {
	const response = await request(api.url)[method](path).set('Authorization', `Bearer ${token}`).send(body);

	expect(response.status).toBe(400);
	expect(response.body.errors).toHaveLength(1);
	return response.body.errors[0];
}

function expectRestParity(graphql: Record<string, unknown>, rest: unknown, field: string) {
	const { path, locations, ...withoutLocation } = graphql;

	expect(path).toEqual([field]);
	expect(locations).toEqual(LOCATION);
	expect(withoutLocation).toEqual(rest);
}

function expectUniqueViolation(error: Record<string, any>, submittedSlug: string) {
	const details = { code: 'RECORD_NOT_UNIQUE', collection: RECORDS, field: 'slug' };

	expect(error['message']).toBe('Field "slug" has to be unique.');
	expect(error['extensions']).toEqual(VENDOR === 'sqlite3' ? details : { ...details, invalid: submittedSlug });
}

async function slugs(api: Api, values: string[]) {
	return (await api.database(RECORDS).whereIn('slug', values).select('slug')).map((row) => row.slug);
}

const test = createIdentityTest({
	env: {
		WEBSOCKETS_ENABLED: 'true',
		WEBSOCKETS_GRAPHQL_ENABLED: 'true',
		WEBSOCKETS_GRAPHQL_AUTH: 'handshake',
		WEBSOCKETS_GRAPHQL_PATH: '/graphql',
	},
}).extend<{ scenarioState: Prerequisite<Scenario>; scenario: Scenario }>({
	scenarioState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<Scenario>(
				async (ready) => {
					const asAdmin = (method: 'post' | 'patch', path: string, body: string | object) =>
						setupRequest(api.url)[method](path).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body).expect(200);

					await CreateCollection(api, {
						collection: RECORDS,
						fields: [
							{ field: 'slug', type: 'string', schema: { is_unique: true } },
							{ field: 'tenant', type: 'string' },
							{ field: 'note', type: 'string' },
						],
					});

					await CreateCollection(api, {
						collection: SETTINGS,
						meta: { singleton: true },
						fields: [{ field: 'title', type: 'string' }],
					});

					await CreateItem(api, { collection: RECORDS, item: { slug: 'alpha', tenant: 'A' } });
					const beta = await CreateItem(api, { collection: RECORDS, item: { slug: 'beta', tenant: 'A' } });

					const tenantB = await CreateItem(api, {
						collection: RECORDS,
						item: { slug: 'tenantb', tenant: 'B', note: TENANT_B_NOTE },
					});

					await asAdmin('patch', `/items/${SETTINGS}`, { title: 'OK start' });

					const role = await CreateRole(api, {
						name: 'graphql_mutation_errors_member',
						appAccessEnabled: false,
						adminAccessEnabled: false,
					});

					const tenantA = { tenant: { _eq: 'A' } };

					for (const permission of [
						{ collection: RECORDS, action: 'create', fields: ['*'], permissions: {} },
						{ collection: RECORDS, action: 'read', fields: ['*'], permissions: tenantA },
						{ collection: RECORDS, action: 'update', fields: ['*'], permissions: tenantA },
						{ collection: SETTINGS, action: 'read', fields: ['*'], permissions: {} },
						{
							collection: SETTINGS,
							action: 'update',
							fields: ['*'],
							permissions: {},
							validation: { title: { _starts_with: 'OK' } },
						},
					]) {
						await asAdmin('post', '/permissions', { role: role.id, ...permission });
					}

					await asAdmin('post', '/users', {
						email: 'graphql-mutation-errors-member@example.com',
						password: 'MemberPassword1',
						token: MEMBER,
						role: role.id,
					});

					await ready({ betaId: beta.id, tenantBId: tenantB.id });
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
			await use(requirePrerequisite(scenarioState, 'GraphQL mutation errors scenario', { task, skip }));
		},
		{ auto: true },
	],
});

describe('GraphQL mutation errors keep their code, details, and location', () => {
	test('report a unique violation in a single create like REST, without writing a row', async ({ api }) => {
		for (const [identity, token] of IDENTITIES) {
			const field = `create_${RECORDS}_item`;
			const note = `single create by ${identity}`;
			const graphql = await graphqlError(api, token, field, { data: { slug: 'alpha', tenant: 'A', note } });
			const rest = await restError(api, token, 'post', `/items/${RECORDS}`, { slug: 'alpha', tenant: 'A', note });

			expectUniqueViolation(graphql, 'alpha');
			expectRestParity(graphql, rest, field);
			expect(await api.database(RECORDS).where({ note }).select('id'), identity).toEqual([]);
		}
	});

	test('report a unique violation in a batch create like REST, without writing any row', async ({ api }) => {
		for (const [identity, token] of IDENTITIES) {
			const field = `create_${RECORDS}_items`;
			const fresh = { graphql: `freshgraphql${identity.length}`, rest: `freshrest${identity.length}` };

			const batch = (slug: string) => [
				{ slug, tenant: 'A' },
				{ slug: 'alpha', tenant: 'A' },
			];

			const graphql = await graphqlError(api, token, field, { data: batch(fresh.graphql) });
			const rest = await restError(api, token, 'post', `/items/${RECORDS}`, batch(fresh.rest));

			expectUniqueViolation(graphql, 'alpha');
			expectRestParity(graphql, rest, field);
			expect(await slugs(api, [fresh.graphql, fresh.rest]), identity).toEqual([]);
		}
	});

	test('report a unique violation in a single update like REST, leaving the row unchanged', async ({
		api,
		scenario,
	}) => {
		for (const [identity, token] of IDENTITIES) {
			const field = `update_${RECORDS}_item`;
			const graphql = await graphqlError(api, token, field, { id: scenario.betaId, data: { slug: 'alpha' } });
			const rest = await restError(api, token, 'patch', `/items/${RECORDS}/${scenario.betaId}`, { slug: 'alpha' });

			expectUniqueViolation(graphql, 'alpha');
			expectRestParity(graphql, rest, field);

			expect(await api.database(RECORDS).where({ id: scenario.betaId }).select('slug'), identity).toEqual([
				{ slug: 'beta' },
			]);
		}
	});

	test('report a unique violation in a batch update like REST, leaving the rows unchanged', async ({
		api,
		scenario,
	}) => {
		for (const [identity, token] of IDENTITIES) {
			const field = `update_${RECORDS}_items`;
			const graphql = await graphqlError(api, token, field, { ids: [scenario.betaId], data: { slug: 'alpha' } });

			const rest = await restError(api, token, 'patch', `/items/${RECORDS}`, {
				keys: [scenario.betaId],
				data: { slug: 'alpha' },
			});

			expectUniqueViolation(graphql, 'alpha');
			expectRestParity(graphql, rest, field);

			expect(await api.database(RECORDS).where({ id: scenario.betaId }).select('slug'), identity).toEqual([
				{ slug: 'beta' },
			]);
		}
	});

	test('report a member singleton validation failure with its code and location like REST', async ({ api }) => {
		const field = `update_${SETTINGS}`;
		const graphql = await graphqlError(api, MEMBER, field, { data: { title: 'bad' } });
		const rest = await restError(api, MEMBER, 'patch', `/items/${SETTINGS}`, { title: 'bad' });

		expect(graphql).toEqual({
			message: 'Validation failed for field "title". Value has to start with the required text.',
			extensions: { code: 'FAILED_VALIDATION', field: 'title', type: 'starts_with' },
			path: [field],
			locations: LOCATION,
		});

		expectRestParity(graphql, rest, field);
		expect(await api.database(SETTINGS).select('title')).toEqual([{ title: 'OK start' }]);
	});

	test('reject a mutation over graphql-ws with a coded error from the same formatter', async ({ api }) => {
		const ws = createWebSocketGql(api.url, { auth: { access_token: MEMBER } });

		try {
			const query = processGraphQLJson({
				mutation: { [`create_${RECORDS}_item`]: { __args: { data: { slug: 'alpha', tenant: 'A' } }, id: true } },
			});

			const errors = await new Promise<unknown>((resolve, reject) => {
				ws.client.subscribe(
					{ query },
					{
						next: () => reject(new Error('unexpected result')),
						error: resolve,
						complete: () => reject(new Error('completed')),
					}
				);
			});

			expect(errors).toEqual([
				{
					message: 'Only subscription operations are supported over the WebSocket transport.',
					extensions: { code: 'INVALID_PAYLOAD' },
				},
			]);
		} finally {
			await ws.client.dispose();
		}

		expect(await slugs(api, ['alpha'])).toEqual(['alpha']);
	});
});

describe('GraphQL errors for one tenant reveal no more of another tenant than REST does', () => {
	test('report a unique violation against an unreadable row like REST, without its other values', async ({
		api,
		scenario,
	}) => {
		const hidden = await request(api.url)
			.get(`/items/${RECORDS}/${scenario.tenantBId}`)
			.set('Authorization', `Bearer ${MEMBER}`);

		expect(hidden.status).toBe(403);

		const listed = await request(api.url).get(`/items/${RECORDS}?fields=slug`).set('Authorization', `Bearer ${MEMBER}`);
		expect(listed.body.data.map((row: { slug: string }) => row.slug)).not.toContain('tenantb');

		const queried = await requestGraphQL(api.url, false, MEMBER, { query: { [RECORDS]: { slug: true } } });
		expect(queried.body.data[RECORDS].map((row: { slug: string }) => row.slug)).not.toContain('tenantb');

		const field = `create_${RECORDS}_item`;
		const graphql = await graphqlError(api, MEMBER, field, { data: { slug: 'tenantb', tenant: 'A' } });
		const rest = await restError(api, MEMBER, 'post', `/items/${RECORDS}`, { slug: 'tenantb', tenant: 'A' });

		expectUniqueViolation(graphql, 'tenantb');
		expectRestParity(graphql, rest, field);
		expect(JSON.stringify({ graphql, rest })).not.toContain(TENANT_B_NOTE);
		expect(await slugs(api, ['tenantb'])).toEqual(['tenantb']);
	});
});

describe('GraphQL request errors carry no stack traces', () => {
	test('send a syntax error to an anonymous caller in the formatted shape', async ({ api }) => {
		const response = await request(api.url).post('/graphql').send({ query: '{ a' });

		expect(response.status).toBe(400);

		expect(response.body).toEqual({
			errors: [
				{
					message: 'GraphQL schema validation error.',
					extensions: {
						code: 'INVALID_PAYLOAD',
						graphqlErrors: [
							{ message: 'Syntax Error: Expected Name, found <EOF>.', locations: [{ line: 1, column: 4 }] },
						],
					},
				},
			],
		});
	});

	test('send a member validation error in the formatted shape', async ({ api }) => {
		const response = await request(api.url)
			.post('/graphql')
			.set('Authorization', `Bearer ${MEMBER}`)
			.send({ query: `mutation { create_${RECORDS}_item_missing(data: {}) { id } }` });

		expect(response.status).toBe(400);
		expect(response.body.errors).toHaveLength(1);
		expect(response.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_EXCEPTION');

		for (const entry of response.body.errors[0].extensions.graphqlErrors) {
			expect(Object.keys(entry).every((key) => ['message', 'locations', 'path', 'extensions'].includes(key))).toBe(
				true
			);
		}

		expect(JSON.stringify(response.body)).not.toContain('"stack"');
	});
});
