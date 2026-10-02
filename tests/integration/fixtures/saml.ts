import { inject } from 'vitest';
import { Wait } from 'testcontainers';
import { readFile } from 'node:fs/promises';
import { withService } from './service';
import { createEnvironmentTest, apiFixtures, type EnvironmentOptions } from './environment';
import { openOrigin } from '../harness/origin.mjs';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';
import request, { setupRequest } from './request';

export const samlImage =
	'kristophjunge/test-saml-idp@sha256:02a6e56c01f94b9ba3f2151f33acedf4606ac9b7eeb62a874c5a6b032c0fa9cc';

const role = 'd70c0943-5b55-4c5d-a613-f539a27a57f5';

export type SamlService = { url: string; configuration: EnvironmentOptions; available: () => boolean };

export async function withSaml(directory: string, signal: AbortSignal, use: (saml: SamlService) => Promise<void>) {
	const origin = await openOrigin();
	const callback = `${origin.url}/auth/login/saml/acs`;

	const errors: unknown[] = [];

	try {
		await withService(
			{
				name: 'saml',
				image: samlImage,
				port: 8080,
				environment: { SIMPLESAMLPHP_SP_ENTITY_ID: 'saml-test', SIMPLESAMLPHP_SP_ASSERTION_CONSUMER_SERVICE: callback },
				wait: Wait.forHttp('/simplesaml/saml2/idp/metadata.php', 8080).forStatusCode(200),
			},
			directory,
			signal,
			async (service) => {
				const url = `http://${service.host}:${service.port}`;
				const metadata = await request(url).get('/simplesaml/saml2/idp/metadata.php').expect(200);
				if (!metadata.text.includes(`${url}/simplesaml/`))
					throw new Error('SAML metadata does not advertise the owned reachable endpoint');

				const sp = (await readFile(new URL('./saml-sp.xml', import.meta.url), 'utf8')).replace(
					'http://host.docker.internal:8055/auth/login/saml/acs',
					callback
				);

				await use({
					url,
					available: service.available,
					configuration: {
						origin,
						env: {
							AUTH_PROVIDERS: 'saml',
							AUTH_SAML_DRIVER: 'saml',
							AUTH_SAML_ALLOW_PUBLIC_REGISTRATION: 'true',
							AUTH_SAML_SP_metadata: sp,
							AUTH_SAML_IDP_metadata: metadata.text,
							AUTH_SAML_DEFAULT_ROLE_ID: role,
							AUTH_SAML_IDENTIFIER_KEY: 'uid',
							AUTH_SAML_EMAIL_KEY: 'email',
						},
					},
				});
			}
		);
	} catch (error) {
		errors.push(error);
	} finally {
		try {
			await origin.close();
		} catch (error) {
			errors.push(error);
		}
	}

	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, 'SAML service and origin cleanup failed');
}

export const samlTest = createEnvironmentTest()
	.extend<{
		samlState: Prerequisite<SamlService>;
		configurationState: Prerequisite<EnvironmentOptions>;
	}>({
		samlState: [
			async ({ cancellationSignal, teardownFailures }, use) => {
				await capturePrerequisite(
					(ready) => withSaml(inject('integration').directory, cancellationSignal, ready),
					use,
					teardownFailures
				);
			},
			{ scope: 'file' },
		],
		configurationState: [
			async ({ samlState }, use) => {
				if (!samlState.ok) return use(samlState);
				await use({ ok: true, value: samlState.value.configuration });
			},
			{ scope: 'file' },
		],
	})
	.extend(apiFixtures)
	.extend<{ samlReady: Prerequisite<SamlService>; saml: SamlService }>({
		samlReady: [
			async ({ apiState, samlState, teardownFailures }, use) => {
				if (!apiState.ok) return use(apiState);
				if (!samlState.ok) return use(samlState);

				await capturePrerequisite(
					async (ready) => {
						const api = apiState.value;

						await setupRequest(api.url)
							.post('/roles')
							.auth(api.adminToken, { type: 'bearer' })
							.send({ id: role, name: 'SAML user', app_access: true, admin_access: false })
							.expect(200);

						await ready(samlState.value);
					},
					use,
					teardownFailures
				);
			},
			{ scope: 'file' },
		],
		saml: [
			async ({ api, samlReady, task, skip }, use) => {
				void api;
				const saml = requirePrerequisite(samlReady, 'SAML identity provider', { task, skip });
				if (!saml.available()) throw new Error('Owned SAML identity provider stopped');
				await use(saml);
			},
			{ auto: true },
		],
	});

export function getCookies(value: string | string[] | undefined): string {
	if (value === undefined) return '';
	return (Array.isArray(value) ? value : [value]).map((cookie) => cookie.split(';')[0]).join(';');
}

export async function samlLogin(url: string, password = 'user1pass') {
	const page = await request(url).get('/simplesaml/module.php/core/authenticate.php?as=example-userpass').expect(302);
	const AuthState = new URL(String(page.headers.location), url).searchParams.get('AuthState');
	if (!AuthState) throw new Error('SAML login form omitted AuthState');
	return request(url)
		.post('/simplesaml/module.php/core/loginuserpass.php?')
		.set('Cookie', getCookies(page.headers['set-cookie']))
		.type('form')
		.send({ username: 'user1', password, AuthState });
}
