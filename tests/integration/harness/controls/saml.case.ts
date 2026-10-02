import { expect } from 'vitest';
import { samlTest as test, samlLogin, getCookies } from '../../fixtures/saml';
import request from '../../fixtures/request';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('invalid SAML credentials do not authenticate', async ({ saml }) => {
	const response = await samlLogin(saml.url, 'user2pass');
	expect(response.statusCode).toBe(200);
	const cookies = getCookies(response.headers['set-cookie']);
	expect(cookies).toMatch(/PHPSESSIDIDP/);
	expect(cookies).not.toMatch(/SimpleSAMLAuthTokenIdp/);
});

test('valid SAML credentials authenticate', async ({ saml }) => {
	const response = await samlLogin(saml.url);
	expect(response.statusCode).toBe(303);
	const cookies = getCookies(response.headers['set-cookie']);
	expect(cookies).toMatch(/PHPSESSIDIDP/);
	expect(cookies).toMatch(/SimpleSAMLAuthTokenIdp/);
});

for (const redirect of [false, true]) {
	test(`real SAML callback returns ${redirect ? 'redirect and cookie' : 'JSON tokens'} independently`, async ({
		api,
		saml,
	}) => {
		const login = await samlLogin(saml.url);
		expect(login.statusCode).toBe(303);
		const cookies = getCookies(login.headers['set-cookie']);
		expect(cookies).toMatch(/SimpleSAMLAuthTokenIdp/);

		const start = await request(api.url)
			.get('/auth/login/saml')
			.query(redirect ? { redirect: '/admin/login?continue' } : {})
			.expect(302);

		const location = new URL(start.headers.location);
		expect(location.origin).toBe(saml.url);

		const auth = await request(location.origin)
			.get(location.pathname + location.search)
			.set('Cookie', cookies)
			.expect(200);

		const SAMLResponse = auth.text.split('<input type="hidden" name="SAMLResponse" value="')[1]?.split('" />')[0];
		expect(SAMLResponse).toBeTruthy();
		const RelayState = auth.text.split('<input type="hidden" name="RelayState" value="')[1]?.split('" />')[0];

		const response = await request(api.url)
			.post('/auth/login/saml/acs')
			.send({ SAMLResponse, ...(redirect ? { RelayState } : {}) })
			.expect(redirect ? 302 : 200);

		if (redirect) {
			expect(getCookies(response.headers['set-cookie'])).toContain('cairncms_refresh_token');
			expect(response.headers.location).toContain('/admin/login?continue');
		} else
			expect(response.body.data).toEqual(
				expect.objectContaining({
					access_token: expect.any(String),
					expires: expect.any(Number),
					refresh_token: expect.any(String),
				})
			);
	});
}
