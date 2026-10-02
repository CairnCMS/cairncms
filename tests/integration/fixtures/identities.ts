import { createApiTest } from './environment';
import { setupRequest as request } from './request';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';

export const USER: Record<string, { TOKEN: string; EMAIL: string; PASSWORD: string; NAME: string }> = {
	ADMIN: { TOKEN: 'AdminToken', EMAIL: 'admin@default.com', PASSWORD: 'AdminPassword', NAME: 'Admin User' },
	APP_ACCESS: {
		TOKEN: 'AppAccessToken',
		EMAIL: 'app-access@default.com',
		PASSWORD: 'AppAccessPassword',
		NAME: 'App Access User',
	},
	API_ONLY: {
		TOKEN: 'APIOnlyToken',
		EMAIL: 'api-only@default.com',
		PASSWORD: 'APIOnlyPassword',
		NAME: 'API Only User',
	},
	NO_ROLE: { TOKEN: 'NoRoleToken', EMAIL: 'no-role@default.com', PASSWORD: 'NoRolePassword', NAME: 'No-Role User' },
};
export const TEST_USERS = ['ADMIN', 'APP_ACCESS', 'API_ONLY', 'NO_ROLE'];
export const PRIMARY_KEY_TYPES = ['integer', 'uuid', 'string'] as const;
export type PrimaryKeyType = (typeof PRIMARY_KEY_TYPES)[number];

export const createIdentityTest = (options: Parameters<typeof createApiTest>[0] = false) =>
	createApiTest(options).extend<{ identityState: Prerequisite<typeof USER>; identities: typeof USER }>({
		identityState: [
			async ({ apiState, teardownFailures }, use) => {
				if (!apiState.ok) return use(apiState);
				const api = apiState.value;

				await capturePrerequisite<typeof USER>(
					async (ready) => {
						const started = performance.now();

						for (const key of TEST_USERS) {
							const user = USER[key]!;
							let role = null;

							if (key !== 'NO_ROLE') {
								const response = await request(api.url)
									.post('/roles')
									.auth(api.adminToken, { type: 'bearer' })
									.send({ name: `${key} Role`, admin_access: key === 'ADMIN', app_access: key !== 'API_ONLY' })
									.expect(200);

								role = response.body.data.id;
								if (typeof role !== 'string') throw new Error(`Missing role ID for ${key}`);
							}

							const response = await request(api.url)
								.post('/users')
								.auth(api.adminToken, { type: 'bearer' })
								.send({ email: user.EMAIL, password: user.PASSWORD, token: user.TOKEN, first_name: user.NAME, role })
								.expect(200);

							if (typeof response.body.data.id !== 'string') throw new Error(`Missing user ID for ${key}`);
						}

						api.recordTiming('identities', started);
						await ready(USER);
					},
					use,
					teardownFailures
				);
			},
			{ scope: 'file' },
		],
		identities: [
			async ({ api, identityState, task, skip }, use) => {
				void api;
				await use(requirePrerequisite(identityState, 'identities', { task, skip }));
			},
			{ auto: true },
		],
	});

export const identityTest = createIdentityTest();
