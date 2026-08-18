import config, { Env, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { ChildProcess, spawn } from 'child_process';
import { cloneDeep } from 'lodash';
import request from 'supertest';

// getUrl() rewrites the port under TEST_LOCAL and TEST_NO_CACHE, which would redirect these requests
// away from the spawned instances, so address them directly by their configured port.
function urlOf(vendor: string, env: Env): string {
	return `http://127.0.0.1:${env[vendor as keyof Env]!.PORT}`;
}

// SQLite cannot safely share a single database file across instances, and these instances need
// distinct trust-proxy, custom-header, and rate-limit configuration.
const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
const describeTrust = supportedVendors.length > 0 ? describe : describe.skip;

describeTrust('trusted client-IP resolution', () => {
	const untrusted = {} as { [vendor: string]: ChildProcess };
	const trusted = {} as { [vendor: string]: ChildProcess };
	const untrustedEnvs = {} as { [vendor: string]: Env };
	const trustedEnvs = {} as { [vendor: string]: Env };

	beforeAll(async () => {
		const promises = [];

		for (const vendor of supportedVendors) {
			const untrustedEnv = cloneDeep(config.envs);
			untrustedEnv[vendor].RATE_LIMITER_ENABLED = 'true';
			untrustedEnv[vendor].RATE_LIMITER_STORE = 'memory';
			untrustedEnv[vendor].RATE_LIMITER_POINTS = '5';
			untrustedEnv[vendor].RATE_LIMITER_DURATION = '10';
			untrustedEnv[vendor].IP_TRUST_PROXY = 'false';
			const untrustedPort = Number(untrustedEnv[vendor]!.PORT) + 500;
			untrustedEnv[vendor]!.PORT = String(untrustedPort);

			untrusted[vendor] = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
				cwd: paths.cwd,
				env: untrustedEnv[vendor],
			});

			untrustedEnvs[vendor] = untrustedEnv;
			promises.push(awaitDirectusConnection(untrustedPort, untrusted[vendor]));

			const trustedEnv = cloneDeep(config.envs);
			trustedEnv[vendor].RATE_LIMITER_ENABLED = 'true';
			trustedEnv[vendor].RATE_LIMITER_STORE = 'memory';
			trustedEnv[vendor].RATE_LIMITER_POINTS = '5';
			trustedEnv[vendor].RATE_LIMITER_DURATION = '10';
			trustedEnv[vendor].IP_TRUST_PROXY = 'loopback';
			trustedEnv[vendor].IP_CUSTOM_HEADER = 'X-Real-IP';
			const trustedPort = Number(trustedEnv[vendor]!.PORT) + 550;
			trustedEnv[vendor]!.PORT = String(trustedPort);

			trusted[vendor] = spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
				cwd: paths.cwd,
				env: trustedEnv[vendor],
			});

			trustedEnvs[vendor] = trustedEnv;
			promises.push(awaitDirectusConnection(trustedPort, trusted[vendor]));
		}

		await Promise.all(promises);
	}, 300000);

	afterAll(async () => {
		const children = [
			...supportedVendors.map((vendor) => untrusted[vendor]!),
			...supportedVendors.map((vendor) => trusted[vendor]!),
		];

		await Promise.all(
			children.map(
				(child) =>
					new Promise<void>((resolve) => {
						if (child.exitCode !== null || child.signalCode !== null) {
							resolve();
							return;
						}

						child.once('exit', () => resolve());
						child.kill();
					})
			)
		);
	});

	it.each(supportedVendors)(
		'%s: an untrusted instance shares one bucket, so a rotating X-Forwarded-For cannot evade the limit',
		async (vendor) => {
			const url = urlOf(vendor, untrustedEnvs[vendor]!);
			const statuses: number[] = [];

			for (let i = 0; i < 10; i++) {
				const res = await request(url).get('/server/ping').set('X-Forwarded-For', `203.0.113.${i}`);
				statuses.push(res.statusCode);
			}

			expect(statuses.every((status) => status === 200 || status === 429)).toBe(true);
			expect(statuses).toContain(200);
			expect(statuses).toContain(429);
		}
	);

	it.each(supportedVendors)('%s: a trusted instance keys the limit on the forwarded client', async (vendor) => {
		const url = urlOf(vendor, trustedEnvs[vendor]!);

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

	it.each(supportedVendors)(
		'%s: a GraphQL login attributes the trusted custom-header IP, not the forwarded or socket address',
		async (vendor) => {
			const url = urlOf(vendor, trustedEnvs[vendor]!);
			const expectedIp = '203.0.113.77';
			const forwarded = '198.51.100.88';
			const userAgent = `trusted-ip-probe-${vendor}`;

			const login = await request(url)
				.post('/graphql/system')
				.set('X-Real-IP', expectedIp)
				.set('X-Forwarded-For', forwarded)
				.set('User-Agent', userAgent)
				.send({
					query: `mutation { auth_login(email: "${common.USER.ADMIN.EMAIL}", password: "${common.USER.ADMIN.PASSWORD}") { access_token } }`,
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
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

			expect(activity.statusCode).toBe(200);
			expect(activity.body.data.length).toBe(1);
			expect(activity.body.data[0].ip).toBe(expectedIp);
		}
	);
});
