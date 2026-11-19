import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest, USER } from '../../fixtures/identities';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const test = createIdentityTest();

const DISALLOWED_RESET_URL = 'https://reset.example.com/password';

type Failure = {
	label: string;
	token?: string;
	rest: { path: string; body: Record<string, unknown> };
	graphql: { field: string; query: string };
	status: number;
	code: string;
};

const FAILURES: Failure[] = [
	{
		label: 'logout with no refresh token',
		rest: { path: '/auth/logout', body: {} },
		graphql: { field: 'auth_logout', query: 'mutation { auth_logout }' },
		status: 400,
		code: 'INVALID_PAYLOAD',
	},
	{
		label: 'refresh with an invalid token',
		rest: { path: '/auth/refresh', body: { refresh_token: 'not-a-session-token', mode: 'json' } },
		graphql: {
			field: 'auth_refresh',
			query: 'mutation { auth_refresh(refresh_token: "not-a-session-token", mode: json) { access_token } }',
		},
		status: 401,
		code: 'INVALID_CREDENTIALS',
	},
	{
		label: 'a password reset with an invalid token',
		rest: { path: '/auth/password/reset', body: { token: 'not-a-reset-token', password: 'NewPassword1' } },
		graphql: {
			field: 'auth_password_reset',
			query: 'mutation { auth_password_reset(token: "not-a-reset-token", password: "NewPassword1") }',
		},
		status: 403,
		code: 'FORBIDDEN',
	},
	{
		label: 'an invite acceptance with an invalid token',
		rest: { path: '/users/invite/accept', body: { token: 'not-an-invite-token', password: 'NewPassword1' } },
		graphql: {
			field: 'users_invite_accept',
			query: 'mutation { users_invite_accept(token: "not-an-invite-token", password: "NewPassword1") }',
		},
		status: 403,
		code: 'FORBIDDEN',
	},
	{
		label: 'a password request with a reset URL outside the allow list',
		rest: { path: '/auth/password/request', body: { email: USER.ADMIN!.EMAIL, reset_url: DISALLOWED_RESET_URL } },
		graphql: {
			field: 'auth_password_request',
			query: `mutation { auth_password_request(email: "${USER.ADMIN!.EMAIL}", reset_url: "${DISALLOWED_RESET_URL}") }`,
		},
		status: 400,
		code: 'INVALID_PAYLOAD',
	},
	{
		label: 'two-factor enable with an invalid one-time password',
		token: USER.APP_ACCESS!.TOKEN,
		rest: { path: '/users/me/tfa/enable', body: { otp: 'not-a-code', secret: 'JBSWY3DPEHPK3PXP' } },
		graphql: {
			field: 'users_me_tfa_enable',
			query: 'mutation { users_me_tfa_enable(otp: "not-a-code", secret: "JBSWY3DPEHPK3PXP") }',
		},
		status: 400,
		code: 'INVALID_PAYLOAD',
	},
];

function post(api: Api, path: string, body: Record<string, unknown>, token?: string) {
	const call = request(api.url).post(path);
	if (token) call.set('Authorization', `Bearer ${token}`);
	return call.send(body);
}

describe('GraphQL auth errors match REST', () => {
	for (const { label, token, rest, graphql, status, code } of FAILURES) {
		test(`report ${label} with the same code and message`, async ({ api }) => {
			const restResponse = await post(api, rest.path, rest.body, token);

			expect(restResponse.status).toBe(status);
			expect(restResponse.body.errors).toHaveLength(1);

			const [restError] = restResponse.body.errors;
			expect(restError.extensions).toEqual({ code });

			const graphqlResponse = await post(api, '/graphql/system', { query: graphql.query }, token);

			expect(graphqlResponse.status).toBe(200);

			expect(graphqlResponse.body.errors).toEqual([
				{ ...restError, locations: [{ line: 1, column: 12 }], path: [graphql.field] },
			]);
		});
	}

	test('report a logout with an unknown token as a success on both transports', async ({ api }) => {
		const restResponse = await post(api, '/auth/logout', { refresh_token: 'not-a-session-token' });

		expect([200, 204]).toContain(restResponse.status);
		expect(restResponse.body.errors).toBeUndefined();

		const graphqlResponse = await post(api, '/graphql/system', {
			query: 'mutation { auth_logout(refresh_token: "not-a-session-token") }',
		});

		expect(graphqlResponse.body).toEqual({ data: { auth_logout: true } });
	});

	test('report a password request for an unknown email as a success on both transports', async ({ api }) => {
		const restResponse = await post(api, '/auth/password/request', { email: 'nobody-here@example.com' });

		expect([200, 204]).toContain(restResponse.status);
		expect(restResponse.body.errors).toBeUndefined();

		const graphqlResponse = await post(api, '/graphql/system', {
			query: 'mutation { auth_password_request(email: "nobody-here@example.com") }',
		});

		expect(graphqlResponse.body).toEqual({ data: { auth_password_request: true } });
	});
});

const UNKNOWN_EMAIL = 'nobody-here@example.com';
const LOGIN = `mutation ($password: String!) { auth_login(email: "${UNKNOWN_EMAIL}", password: $password) { access_token } }`;

const ALIASED_LOGIN = `mutation ($password: String!) { signin: auth_login(email: "${UNKNOWN_EMAIL}", password: $password) { access_token } }`;

describe('GraphQL login error locations', () => {
	for (const [label, query, responseKey, password] of [
		['the line', LOGIN, 'auth_login', '1'],
		['the column', LOGIN, 'auth_login', String(LOGIN.indexOf('auth_login') + 1)],
		['part of the field name', LOGIN, 'auth_login', 'login'],
		['the alias', ALIASED_LOGIN, 'signin', 'signin'],
	] as const) {
		test(`keep the location of a failed login when the password matches ${label}`, async ({ api }) => {
			const restResponse = await post(api, '/auth/login', { email: UNKNOWN_EMAIL, password });

			expect(restResponse.status).toBe(401);
			expect(restResponse.body.errors).toHaveLength(1);

			const [restError] = restResponse.body.errors;
			expect(restError.extensions).toEqual({ code: 'INVALID_CREDENTIALS' });

			const graphqlResponse = await post(api, '/graphql/system', { query, variables: { password } });

			expect(graphqlResponse.status).toBe(200);

			expect(graphqlResponse.body.errors).toEqual([
				{ ...restError, locations: [{ line: 1, column: query.indexOf(responseKey) + 1 }], path: [responseKey] },
			]);
		});
	}
});
