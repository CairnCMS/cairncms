import { describe, expect } from 'vitest';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request, { requestGraphQL, setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';
import { createWebSocketConn } from '../realtime/transport';

initializeFixtures();

const COLLECTION = 'custom_error_records';
const SETTINGS = 'custom_error_settings';
const EXTENSION = 'cairncms-extension-custom-errors';
const ADMIN = `Bearer ${USER.ADMIN!.TOKEN}`;

const IDENTITIES = [
	['an administrator', USER.ADMIN!.TOKEN],
	['a user without administrator access', USER.APP_ACCESS!.TOKEN],
] as const;

const QUOTA_ERROR = {
	errors: [{ message: 'The quota is used up.', extensions: { code: 'QUOTA_EXCEEDED', limit: 5 } }],
};

const test = createIdentityTest({
	extensions: [EXTENSION],
	env: {
		WEBSOCKETS_ENABLED: 'true',
		WEBSOCKETS_REST_ENABLED: 'true',
		WEBSOCKETS_REST_AUTH: 'handshake',
		WEBSOCKETS_REST_PATH: '/websocket',
	},
}).extend<{ schemaState: Prerequisite<void>; schema: void }>({
	schemaState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<void>(
				async (ready) => {
					await setupRequest(api.url)
						.post('/collections')
						.set('Authorization', ADMIN)
						.send({
							collection: COLLECTION,
							meta: {},
							schema: {},
							fields: [
								{
									field: 'id',
									type: 'integer',
									meta: { hidden: true, interface: 'input', readonly: true },
									schema: { is_primary_key: true, has_auto_increment: true },
								},
								{ field: 'title', type: 'string', meta: {}, schema: {} },
							],
						})
						.expect(200);

					const roles = await setupRequest(api.url)
						.get('/roles')
						.query({ filter: JSON.stringify({ name: { _eq: 'APP_ACCESS Role' } }) })
						.set('Authorization', ADMIN)
						.expect(200);

					const role = roles.body.data[0]?.id;
					if (typeof role !== 'string') throw new Error('Missing the role for the user without administrator access');

					await setupRequest(api.url)
						.post('/collections')
						.set('Authorization', ADMIN)
						.send({
							collection: SETTINGS,
							meta: { singleton: true },
							schema: {},
							fields: [
								{
									field: 'id',
									type: 'integer',
									meta: { hidden: true, interface: 'input', readonly: true },
									schema: { is_primary_key: true, has_auto_increment: true },
								},
								{ field: 'title', type: 'string', meta: {}, schema: {} },
							],
						})
						.expect(200);

					await setupRequest(api.url)
						.patch(`/items/${SETTINGS}`)
						.set('Authorization', ADMIN)
						.send({ title: 'within quota' })
						.expect(200);

					for (const permission of [
						{ collection: COLLECTION, action: 'create', fields: ['title'], permissions: {} },
						{ collection: COLLECTION, action: 'read', fields: ['id', 'title'], permissions: {} },
						{ collection: SETTINGS, action: 'read', fields: ['id', 'title'], permissions: {} },
						{ collection: SETTINGS, action: 'update', fields: ['title'], permissions: {} },
					]) {
						await setupRequest(api.url)
							.post('/permissions')
							.set('Authorization', ADMIN)
							.send({ role, ...permission })
							.expect(200);
					}

					await ready();
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	schema: [
		async ({ api, identities, schemaState, task, skip }, use) => {
			void api;
			void identities;
			requirePrerequisite(schemaState, 'custom errors schema', { task, skip });
			await use();
		},
		{ auto: true },
	],
});

describe('Custom exceptions raised by a full-authority extension', () => {
	test('an endpoint returns the custom status, code, message, and details to every requester', async ({ api }) => {
		for (const [label, token] of IDENTITIES) {
			const response = await request(api.url).post('/custom-errors/quota').set('Authorization', `Bearer ${token}`);

			expect(response.status, label).toBe(429);
			expect(response.body, label).toEqual(QUOTA_ERROR);
		}
	});

	test('a filter hook rejects an item create over REST with the custom exception', async ({ api }) => {
		for (const [label, token] of IDENTITIES) {
			const response = await request(api.url)
				.post(`/items/${COLLECTION}`)
				.set('Authorization', `Bearer ${token}`)
				.send({ title: 'over quota' });

			expect(response.status, label).toBe(429);
			expect(response.body, label).toEqual(QUOTA_ERROR);
		}

		const allowed = await request(api.url)
			.post(`/items/${COLLECTION}`)
			.set('Authorization', ADMIN)
			.send({ title: 'within quota' });

		expect(allowed.status).toBe(200);
		expect(await api.database(COLLECTION).where({ title: 'over quota' }).select('id')).toEqual([]);
	});

	for (const [label, field, collection] of [
		['item create', `create_${COLLECTION}_item`, COLLECTION],
		['singleton update', `update_${SETTINGS}`, SETTINGS],
	] as const) {
		test(`a GraphQL ${label} returns the custom code, message, details, and location`, async ({ api }) => {
			for (const [identity, token] of IDENTITIES) {
				const response = await requestGraphQL(api.url, false, token, {
					mutation: { [field]: { __args: { data: { title: 'over quota' } }, id: true } },
				});

				expect(response.status, identity).toBe(200);

				expect(response.body.errors, identity).toEqual([
					{
						message: 'The quota is used up.',
						extensions: { code: 'QUOTA_EXCEEDED', limit: 5 },
						locations: [{ line: 1, column: 12 }],
						path: [field],
					},
				]);
			}

			expect(await api.database(collection).where({ title: 'over quota' }).select('id')).toEqual([]);
		});
	}

	test('the realtime item protocol returns the custom code with its fixed message and no details', async ({ api }) => {
		for (const [label, token] of IDENTITIES) {
			const ws = createWebSocketConn(api.url, { auth: { access_token: token } });

			try {
				await ws.sendMessage({
					type: 'items',
					uid: 'create',
					collection: COLLECTION,
					action: 'create',
					data: { title: 'over quota' },
				});

				const frames = await ws.getMessages(1, { uid: 'create' });

				expect(frames?.[0], label).toEqual({
					type: 'items',
					status: 'error',
					uid: 'create',
					error: { code: 'QUOTA_EXCEEDED', message: 'The request could not be completed.' },
				});
			} finally {
				ws.conn.close();
			}
		}

		expect(await api.database(COLLECTION).where({ title: 'over quota' }).select('id')).toEqual([]);
	});

	test('a request secret echoed into the message and details is redacted for every requester', async ({ api }) => {
		const secret = 'custom-errors-request-secret-4f1c9b';

		for (const [label, token] of IDENTITIES) {
			const response = await request(api.url)
				.post('/custom-errors/echo')
				.set('Authorization', `Bearer ${token}`)
				.send({ password: secret });

			expect(response.status, label).toBe(429);

			expect(response.body, label).toEqual({
				errors: [
					{
						message: 'The quota is used up for --redact--.',
						extensions: { code: 'QUOTA_EXCEEDED', limit: 5, submitted: '--redact--' },
					},
				],
			});

			expect(JSON.stringify(response.body), label).not.toContain(secret);
		}
	});
});
