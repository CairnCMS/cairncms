import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { CreateItem, setupRequest } from '../../fixtures/request';
import { CreateCollection, CreateFieldM2O, CreateRole } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { createWebSocketConn } from '../realtime/transport';

initializeFixtures();

const TENANTS = 'validation_detail_tenants';
const RECORDS = 'validation_detail_records';
const ADMIN = `Bearer ${USER.ADMIN!.TOKEN}`;

const SECRET_A = 'TENANT_A_SECRET_7c1e';
const SECRET_B = 'TENANT_B_SECRET_93fa';
const TRIGGER = 'blocked_status_trigger';
const TENANT_B_MARKER = 'TENANT_B_MARKER_51d0';
const PREFIX = 'PREFIX_MARKER_e2b4';
const SUBMITTED_TITLE = 'SUBMITTED_TITLE_8a6f';
const POLICY_PASSWORD = 'POLICY_PASSWORD_4d2c';
const LOG_BARRIER = 'realtime_log_barrier_0b7e';
const NUMERIC_SECRET = '73915482';

const MEMBER_A = 'ValidationDetailMemberA';
const MEMBER_B = 'ValidationDetailMemberB';
const MEMBER_NUMERIC = 'ValidationDetailMemberNumeric';
const MEMBER_NULL = 'ValidationDetailMemberNull';
const MEMBER_EMPTY = 'ValidationDetailMemberEmpty';

const REQUIRED_VALUE_MESSAGE = 'Validation failed for field "code". Value has to be the required value.';

type Scenario = { secretFor: Record<string, string> };

let recordCount = 0;

function payload(overrides: Record<string, unknown>) {
	recordCount += 1;

	return { code: SECRET_A, status: 'ok', title: `${PREFIX} title`, marker: `record_${recordCount}`, ...overrides };
}

async function logsSince(api: Api, offset: number, presentInEveryRun: string) {
	await expect.poll(async () => (await api.readLogs()).slice(offset), { timeout: 10_000 }).toContain(presentInEveryRun);
	return (await api.readLogs()).slice(offset);
}

async function logsThroughLine(api: Api, offset: number, parts: string[]) {
	const window = async () => (await api.readLogs()).slice(offset);

	await expect
		.poll(async () => (await window()).split('\n').some((line) => parts.every((part) => line.includes(part))), {
			timeout: 10_000,
		})
		.toBe(true);

	return window();
}

async function validationLogEntries(api: Api, offset: number) {
	const logs = await logsThroughLine(api, offset, ['"type":"FailedValidationException"']);

	return logs
		.split('\n')
		.filter((line) => line.includes('"type":"FailedValidationException"'))
		.map((line) => {
			const { message, extensions } = JSON.parse(line).err;
			return { message, extensions };
		});
}

function graphqlValidationLine(mutation: string, field: string) {
	return [`"path":["${mutation}"]`, '"code":"FAILED_VALIDATION"', `"field":"${field}"`];
}

async function expectNoRecord(api: Api, marker: unknown) {
	expect(await api.database(RECORDS).where({ marker }).select('id')).toEqual([]);
}

const test = createIdentityTest({
	env: {
		LOG_STYLE: 'raw',
		LOG_LEVEL: 'debug',
		WEBSOCKETS_ENABLED: 'true',
		WEBSOCKETS_REST_ENABLED: 'true',
		WEBSOCKETS_REST_AUTH: 'handshake',
		WEBSOCKETS_REST_PATH: '/websocket',
	},
}).extend<{ scenarioState: Prerequisite<Scenario>; scenario: Scenario }>({
	scenarioState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<Scenario>(
				async (ready) => {
					const asAdmin = (method: 'post' | 'patch', path: string, body: Record<string, unknown>) =>
						setupRequest(api.url)[method](path).set('Authorization', ADMIN).send(body).expect(200);

					await CreateCollection(api, {
						collection: TENANTS,
						fields: [
							{ field: 'name', type: 'string' },
							{ field: 'secret_code', type: 'string' },
						],
					});

					await CreateCollection(api, {
						collection: RECORDS,
						fields: [
							{ field: 'code', type: 'string' },
							{ field: 'status', type: 'string' },
							{ field: 'marker', type: 'string' },
							{
								field: 'title',
								type: 'string',
								meta: { validation: { title: { _starts_with: PREFIX } } },
							},
						],
					});

					const title = await setupRequest(api.url)
						.get(`/fields/${RECORDS}/title`)
						.set('Authorization', ADMIN)
						.expect(200);

					expect(title.body.data.meta.validation).toEqual({ title: { _starts_with: PREFIX } });

					await CreateFieldM2O(api, { collection: 'directus_users', field: 'tenant', otherCollection: TENANTS });

					const tenantA = await CreateItem(api, { collection: TENANTS, item: { name: 'A', secret_code: SECRET_A } });
					const tenantB = await CreateItem(api, { collection: TENANTS, item: { name: 'B', secret_code: SECRET_B } });

					const tenantNumeric = await CreateItem(api, {
						collection: TENANTS,
						item: { name: 'Numeric', secret_code: NUMERIC_SECRET },
					});

					const tenantNull = await CreateItem(api, { collection: TENANTS, item: { name: 'Null', secret_code: null } });
					const tenantEmpty = await CreateItem(api, { collection: TENANTS, item: { name: 'Empty', secret_code: '' } });

					const stored = await api.database(TENANTS).select('name', 'secret_code').orderBy('name');

					expect(stored).toEqual([
						{ name: 'A', secret_code: SECRET_A },
						{ name: 'B', secret_code: SECRET_B },
						{ name: 'Empty', secret_code: '' },
						{ name: 'Null', secret_code: null },
						{ name: 'Numeric', secret_code: NUMERIC_SECRET },
					]);

					const role = await CreateRole(api, {
						name: 'validation_detail_member',
						appAccessEnabled: false,
						adminAccessEnabled: false,
					});

					await asAdmin('post', '/permissions', {
						role: role.id,
						collection: RECORDS,
						action: 'create',
						fields: ['*'],
						validation: {
							_and: [
								{ code: { _eq: '$CURRENT_USER.tenant.secret_code' } },
								{ status: { _nin: [TRIGGER, TENANT_B_MARKER] } },
							],
						},
					});

					await asAdmin('post', '/permissions', {
						role: role.id,
						collection: RECORDS,
						action: 'read',
						fields: ['id', 'title', 'status', 'marker'],
						permissions: {},
					});

					for (const [token, tenant] of [
						[MEMBER_A, tenantA.id],
						[MEMBER_B, tenantB.id],
						[MEMBER_NUMERIC, tenantNumeric.id],
						[MEMBER_NULL, tenantNull.id],
						[MEMBER_EMPTY, tenantEmpty.id],
					] as const) {
						await asAdmin('post', '/users', {
							email: `${token.toLowerCase()}@example.com`,
							password: 'MemberPassword1',
							token,
							role: role.id,
							tenant,
						});
					}

					await ready({ secretFor: { [MEMBER_A]: SECRET_A, [MEMBER_B]: SECRET_B } });
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
			await use(requirePrerequisite(scenarioState, 'validation error details scenario', { task, skip }));
		},
		{ auto: true },
	],
});

function createAs(api: Api, token: string, body: Record<string, unknown>) {
	return request(api.url).post(`/items/${RECORDS}`).set('Authorization', `Bearer ${token}`).send(body);
}

describe('Validation errors from a permission rule with hidden operands', () => {
	test('accept a write that satisfies every rule', async ({ api }) => {
		const body = payload({});
		const response = await createAs(api, MEMBER_A, body);

		expect([200, 204]).toContain(response.status);
		expect(await api.database(RECORDS).where({ marker: body.marker }).select('id')).toHaveLength(1);
	});

	test('name the field and rule for each tenant without either tenant secret, over REST and in the logs', async ({
		api,
		scenario,
	}) => {
		for (const token of [MEMBER_A, MEMBER_B]) {
			const body = payload({ code: 'wrong-guess' });
			const offset = (await api.readLogs()).length;
			const response = await createAs(api, token, body);

			expect(response.status, token).toBe(400);

			expect(response.body.errors, token).toEqual([
				{
					message: 'Validation failed for field "code". Value has to be the required value.',
					extensions: { code: 'FAILED_VALIDATION', field: 'code', type: 'eq' },
				},
			]);

			const logs = await logsSince(api, offset, 'FAILED_VALIDATION');

			for (const secret of Object.values(scenario.secretFor)) {
				expect(JSON.stringify(response.body), token).not.toContain(secret);
				expect(logs, token).not.toContain(secret);
			}

			await expectNoRecord(api, body.marker);
		}
	});

	for (const [label, token] of [
		['a word', MEMBER_A],
		['a numeric string', MEMBER_NUMERIC],
		['null', MEMBER_NULL],
		['empty', MEMBER_EMPTY],
	] as const) {
		test(`report the same required-value error when the hidden value is ${label}`, async ({ api }) => {
			const body = payload({ code: 'wrong-guess' });
			const offset = (await api.readLogs()).length;
			const response = await createAs(api, token, body);

			expect(response.status).toBe(400);

			expect(response.body.errors).toEqual([
				{ message: REQUIRED_VALUE_MESSAGE, extensions: { code: 'FAILED_VALIDATION', field: 'code', type: 'eq' } },
			]);

			expect(await validationLogEntries(api, offset)).toEqual([
				{ message: REQUIRED_VALUE_MESSAGE, extensions: { field: 'code', type: 'eq' } },
			]);

			await expectNoRecord(api, body.marker);
		});
	}

	test('reject a status from the literal list without naming the other tenant', async ({ api }) => {
		const body = payload({ status: TRIGGER });
		const offset = (await api.readLogs()).length;
		const response = await createAs(api, MEMBER_A, body);

		expect(response.status).toBe(400);

		expect(response.body.errors).toEqual([
			{
				message: `Validation failed for field "status". Value can't be one of the excluded values.`,
				extensions: { code: 'FAILED_VALIDATION', field: 'status', type: 'nin' },
			},
		]);

		expect(JSON.stringify(response.body)).not.toContain(TENANT_B_MARKER);
		expect(await logsSince(api, offset, 'FAILED_VALIDATION')).not.toContain(TENANT_B_MARKER);
		await expectNoRecord(api, body.marker);
	});

	test('reject a title from the field rule without echoing it or the required prefix', async ({ api }) => {
		const body = payload({ title: SUBMITTED_TITLE });
		const offset = (await api.readLogs()).length;
		const response = await createAs(api, MEMBER_A, body);

		expect(response.status).toBe(400);

		expect(response.body.errors).toEqual([
			{
				message: 'Validation failed for field "title". Value has to start with the required text.',
				extensions: { code: 'FAILED_VALIDATION', field: 'title', type: 'starts_with' },
			},
		]);

		const logs = await logsSince(api, offset, 'FAILED_VALIDATION');

		for (const marker of [SUBMITTED_TITLE, PREFIX]) {
			expect(JSON.stringify(response.body)).not.toContain(marker);
			expect(logs).not.toContain(marker);
		}

		await expectNoRecord(api, body.marker);
	});

	test('report the failure over the realtime item protocol with its code and no details', async ({ api, scenario }) => {
		const body = payload({ code: 'wrong-guess' });
		const offset = (await api.readLogs()).length;
		const ws = createWebSocketConn(api.url, { auth: { access_token: MEMBER_A } });

		try {
			await ws.sendMessage({ type: 'items', uid: 'create', collection: RECORDS, action: 'create', data: body });
			const frames = await ws.getMessages(1, { uid: 'create' });

			expect(frames?.[0]).toEqual({
				type: 'items',
				status: 'error',
				uid: 'create',
				error: { code: 'FAILED_VALIDATION', message: 'The payload failed validation.' },
			});

			for (const secret of Object.values(scenario.secretFor)) {
				expect(JSON.stringify(frames)).not.toContain(secret);
			}
		} finally {
			ws.conn.close();
		}

		await request(api.url).get(`/${LOG_BARRIER}`).expect(404);
		const logs = await logsThroughLine(api, offset, ['ROUTE_NOT_FOUND', LOG_BARRIER]);

		for (const secret of Object.values(scenario.secretFor)) {
			expect(logs).not.toContain(secret);
		}

		await expectNoRecord(api, body.marker);
	});

	test('keep the hidden operand out of a GraphQL mutation response and its error log', async ({ api, scenario }) => {
		const body = payload({ code: 'wrong-guess' });
		const offset = (await api.readLogs()).length;

		const response = await request(api.url)
			.post('/graphql')
			.set('Authorization', `Bearer ${MEMBER_A}`)
			.send({
				query: `mutation { create_${RECORDS}_item(data: { code: "wrong-guess", status: "ok", title: "${body.title}", marker: "${body.marker}" }) { id } }`,
			});

		expect(response.body.errors).toEqual([
			{ message: 'An unexpected error occurred.', extensions: { code: 'INTERNAL_SERVER_ERROR' } },
		]);

		const logs = await logsThroughLine(api, offset, graphqlValidationLine(`create_${RECORDS}_item`, 'code'));

		for (const secret of Object.values(scenario.secretFor)) {
			expect(JSON.stringify(response.body)).not.toContain(secret);
			expect(logs).not.toContain(secret);
		}

		await expectNoRecord(api, body.marker);
	});
});

async function withPasswordPolicy(api: Api, run: () => Promise<void>) {
	await setupRequest(api.url)
		.patch('/settings')
		.set('Authorization', ADMIN)
		.send({ auth_password_policy: '/^.{64,}$/' })
		.expect(200);

	try {
		await run();
	} finally {
		await setupRequest(api.url)
			.patch('/settings')
			.set('Authorization', ADMIN)
			.send({ auth_password_policy: null })
			.expect(200);
	}
}

describe('Validation errors from the password policy', () => {
	test('leave the password out of the REST response and its log', async ({ api }) => {
		await withPasswordPolicy(api, async () => {
			const offset = (await api.readLogs()).length;

			const response = await request(api.url)
				.post('/users')
				.set('Authorization', ADMIN)
				.send({ email: 'policy-rest@example.com', password: POLICY_PASSWORD });

			expect(response.status).toBe(400);

			expect(response.body.errors).toEqual([
				{
					message: `Validation failed for field "password". Value doesn't have the correct format.`,
					extensions: { code: 'FAILED_VALIDATION', field: 'password', type: 'regex' },
				},
			]);

			expect(await logsSince(api, offset, 'FAILED_VALIDATION')).not.toContain(POLICY_PASSWORD);
		});
	});

	test('leave an inline GraphQL password out of the response and the error log', async ({ api }) => {
		await withPasswordPolicy(api, async () => {
			const offset = (await api.readLogs()).length;

			const response = await request(api.url)
				.post('/graphql/system')
				.set('Authorization', ADMIN)
				.send({
					query: `mutation { create_users_item(data: { email: "policy-graphql@example.com", password: "${POLICY_PASSWORD}" }) { id } }`,
				});

			expect(response.body.errors?.[0]?.path).toEqual(['create_users_item']);
			expect(JSON.stringify(response.body)).not.toContain(POLICY_PASSWORD);

			const logs = await logsThroughLine(api, offset, graphqlValidationLine('create_users_item', 'password'));

			expect(logs).not.toContain(POLICY_PASSWORD);
		});
	});
});
