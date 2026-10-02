import { expect, inject, vi } from 'vitest';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { describeForVendors } from '../../fixtures/applicability';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

vi.setConfig({ hookTimeout: 300_000 });
initializeFixtures();

const vendor = inject('integration').vendor;
type Clients = { untrusted: string; trusted: string };

const limiter = {
	RATE_LIMITER_ENABLED: 'true',
	RATE_LIMITER_STORE: 'memory',
	RATE_LIMITER_POINTS: '5',
	RATE_LIMITER_DURATION: '10',
};

const test = createIdentityTest().extend<{ clientsState: Prerequisite<Clients>; clients: Clients }>({
	clientsState: [
		async ({ apiState, identityState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!identityState.ok) return use(identityState);
			const api = apiState.value;

			await capturePrerequisite<Clients>(
				async (ready) => {
					const untrusted = await api.start({ ...limiter, IP_TRUST_PROXY: 'false' });

					try {
						const trusted = await api.start({ ...limiter, IP_TRUST_PROXY: 'loopback', IP_CUSTOM_HEADER: 'X-Real-IP' });

						try {
							// Direct listeners preserve the socket-address boundary under test.
							await ready({ untrusted: untrusted.url, trusted: trusted.url });
						} finally {
							await api.stop(trusted.child);
						}
					} finally {
						await api.stop(untrusted.child);
					}
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	clients: [
		async ({ api, identities, clientsState, task, skip }, use) => {
			void api;
			void identities;
			await use(requirePrerequisite(clientsState, 'trusted and untrusted client-IP instances', { task, skip }));
		},
		{ auto: true },
	],
});

describeForVendors(
	'trusted client-IP resolution',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'The shared-database proxy and limiter scenario has not been validated on SQLite.',
	() => {
		test('an untrusted instance shares one bucket, so a rotating X-Forwarded-For cannot evade the limit', async ({
			clients,
		}) => {
			const url = clients.untrusted;
			const statuses: number[] = [];

			for (let i = 0; i < 10; i++) {
				const res = await request(url).get('/server/ping').set('X-Forwarded-For', `203.0.113.${i}`);
				statuses.push(res.statusCode);
			}

			expect(statuses.every((status) => status === 200 || status === 429)).toBe(true);
			expect(statuses).toContain(200);
			expect(statuses).toContain(429);
		});

		test('a trusted instance keys the limit on the forwarded client', async ({ clients }) => {
			const url = clients.trusted;

			const rotating: number[] = [];

			for (let i = 0; i < 10; i++) {
				const res = await request(url).get('/server/ping').set('X-Forwarded-For', `198.51.100.${i}`);
				rotating.push(res.statusCode);
			}

			expect(rotating.every((status) => status === 200)).toBe(true);

			const repeated: number[] = [];

			for (let i = 0; i < 10; i++) {
				const res = await request(url).get('/server/ping').set('X-Forwarded-For', '198.51.100.240');
				repeated.push(res.statusCode);
			}

			expect(repeated.every((status) => status === 200 || status === 429)).toBe(true);
			expect(repeated[0]).toBe(200);
			expect(repeated).toContain(429);
		});

		test('a GraphQL login attributes the trusted custom-header IP, not the forwarded or socket address', async ({
			clients,
		}) => {
			const url = clients.trusted;
			const expectedIp = '203.0.113.77';
			const forwarded = '198.51.100.88';
			const userAgent = `trusted-ip-probe-${vendor}`;

			const login = await request(url)
				.post('/graphql/system')
				.set('X-Real-IP', expectedIp)
				.set('X-Forwarded-For', forwarded)
				.set('User-Agent', userAgent)
				.send({
					query: `mutation { auth_login(email: "${USER.ADMIN!.EMAIL}", password: "${
						USER.ADMIN!.PASSWORD
					}") { access_token } }`,
				});

			expect(login.statusCode).toBe(200);
			expect(login.body?.data?.auth_login?.access_token).toEqual(expect.any(String));

			const activity = await request(url)
				.get('/activity')
				.query({
					'filter[action][_eq]': 'login',
					'filter[user_agent][_eq]': userAgent,
					sort: '-id',
					limit: '1',
					fields: 'ip,action,user_agent',
				})
				.set('X-Real-IP', '203.0.113.201')
				.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`);

			expect(activity.statusCode).toBe(200);
			expect(activity.body.data.length).toBe(1);
			expect(activity.body.data[0].ip).toBe(expectedIp);
		});
	}
);
