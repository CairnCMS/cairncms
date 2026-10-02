import { describe, expect } from 'vitest';
import { samlTest, samlLogin, getCookies as cookiesFromResponse } from '../../fixtures/saml';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const test = samlTest.extend<{ authCookies: Record<string, string> }>({
	authCookies: async ({ saml, vendor }, use) => {
		const response = await samlLogin(saml.url);
		expect(response.statusCode).toBe(303);
		const cookies = cookiesFromResponse(response.headers['set-cookie']);
		expect(cookies).toMatch(/PHPSESSIDIDP/);
		expect(cookies).toMatch(/SimpleSAMLAuthTokenIdp/);
		await use({ [vendor]: cookies });
	},
});

initializeFixtures();

describe('/auth/login/saml', () => {
	const getCookies = (setCookie: string | string[] | undefined): string => {
		if (setCookie === undefined) return '';
		const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
		return cookies.map((cookie) => cookie.split(';')[0]).join(';');
	};

	describe('GET /', () => {
		describe('when incorrect credential is provided', () => {
			describe('returns no authenticated cookie', () => {
				test('REST', async ({ saml, vendor }) => {
					const authCookies: Record<string, string> = {};

					// Action
					const loginPage = await request(saml.url)
						.get(`/simplesaml/module.php/core/authenticate.php?as=example-userpass`)
						.expect(302);

					const cookies = getCookies(loginPage.headers['set-cookie']);

					const AuthState = decodeURIComponent(String(loginPage.headers.location)).split('AuthState=')[1];

					const response = await request(saml.url)
						.post(`/simplesaml/module.php/core/loginuserpass.php?`)
						.set('Cookie', cookies)
						.set('Content-Type', 'application/x-www-form-urlencoded')
						.send({
							username: 'user1',
							password: 'user2pass',
							AuthState,
						})
						.expect(200);

					authCookies[vendor] = getCookies(response.headers['set-cookie']);

					// Assert
					expect(authCookies[vendor]).toMatch(/PHPSESSIDIDP/);
					expect(authCookies[vendor]).not.toMatch(/SimpleSAMLAuthTokenIdp/);
				});
			});
		});

		describe('when correct credential is provided', () => {
			describe('returns authenticated cookie', () => {
				test('REST', async ({ saml, vendor }) => {
					const authCookies: Record<string, string> = {};

					// Action
					const loginPage = await request(saml.url)
						.get(`/simplesaml/module.php/core/authenticate.php?as=example-userpass`)
						.expect(302);

					const cookies = getCookies(loginPage.headers['set-cookie']);

					const AuthState = decodeURIComponent(String(loginPage.headers.location)).split('AuthState=')[1];

					const response = await request(saml.url)
						.post(`/simplesaml/module.php/core/loginuserpass.php?`)
						.set('Cookie', cookies)
						.set('Content-Type', 'application/x-www-form-urlencoded')
						.send({
							username: 'user1',
							password: 'user1pass',
							AuthState,
						})
						.expect(303);

					authCookies[vendor] = getCookies(response.headers['set-cookie']);

					// Assert
					expect(authCookies[vendor]).toMatch(/PHPSESSIDIDP/);
					expect(authCookies[vendor]).toMatch(/SimpleSAMLAuthTokenIdp/);
				});
			});
		});
	});

	describe('POST /acs', () => {
		describe('when no redirect is provided', () => {
			describe('returns directus refresh token in JSON', () => {
				test('REST', async ({ api, vendor, authCookies }) => {
					// Action
					const samlLogin = await request(api.url).get('/auth/login/saml').expect(302);
					const samlRedirectUrl = String(samlLogin.headers.location).split('/simplesaml/');

					const authResponse = await request(samlRedirectUrl[0])
						.get(`/simplesaml/${samlRedirectUrl[1]}`)
						.set('Cookie', authCookies[vendor]);

					expect(authResponse.statusCode).toBe(200);

					const SAMLResponse = authResponse.text
						.split('<input type="hidden" name="SAMLResponse" value="')[1]
						.split('" />')[0];

					const acsResponse = await request(api.url)
						.post('/auth/login/saml/acs')
						.send({
							SAMLResponse,
						})
						.expect(200);

					// Assert
					expect(acsResponse.body.data).toEqual(
						expect.objectContaining({
							access_token: expect.any(String),
							expires: expect.any(Number),
							refresh_token: expect.any(String),
						})
					);
				});
			});
		});

		describe('when redirect is provided', () => {
			describe('returns directus refresh token in cookie', () => {
				test('REST', async ({ api, vendor, authCookies }) => {
					// Action
					const samlLogin = await request(api.url)
						.get(`/auth/login/saml?redirect=${encodeURIComponent('/admin/login?continue')}`)
						.expect(302);

					const samlRedirectUrl = String(samlLogin.headers.location).split('/simplesaml/');

					const authResponse = await request(samlRedirectUrl[0])
						.get(`/simplesaml/${samlRedirectUrl[1]}`)
						.set('Cookie', authCookies[vendor]);

					expect(authResponse.statusCode).toBe(200);

					const SAMLResponse = authResponse.text
						.split('<input type="hidden" name="SAMLResponse" value="')[1]
						.split('" />')[0];

					const RelayState = authResponse.text
						.split('<input type="hidden" name="RelayState" value="')[1]
						.split('" />')[0];

					const acsResponse = await request(api.url)
						.post('/auth/login/saml/acs')
						.send({
							SAMLResponse,
							RelayState,
						})
						.expect(302);

					const cookies = getCookies(acsResponse.headers['set-cookie']);

					// Assert
					expect(cookies).toContain('cairncms_refresh_token');
				});
			});
		});
	});
});
