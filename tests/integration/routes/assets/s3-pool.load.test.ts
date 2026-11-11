import { describe, expect, inject } from 'vitest';
import { createReadStream, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as common from '../../common/functions';
import { type Api } from '../../fixtures/environment';
import request, { setupRequest } from '../../fixtures/request';
import { createStorageTest } from '../../fixtures/storage';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const test = createStorageTest();
const autocannon = createRequire(import.meta.url).resolve('autocannon/autocannon.js');
const imageFilePath = fileURLToPath(new URL('../../fixtures/assets/layers.png', import.meta.url));
const imageBytes = readFileSync(imageFilePath);

const ATTACK_REQUESTS = 600;
const UNSERVABLE_TYPE = 'image/png\u0001';
const VICTIM_DEADLINE_MS = 60_000;

type VictimOutcome =
	| { kind: 'response'; status: number; bodyMatches: boolean }
	| { kind: 'transport error'; message: string }
	| { kind: 'client timeout' };

async function createTenant(api: Api, name: string, token: string) {
	const role = await common.CreateRole(api, { name, appAccessEnabled: false, adminAccessEnabled: false });
	const ownFiles = { uploaded_by: { _eq: '$CURRENT_USER' } };

	for (const [action, permissions] of [
		['create', {}],
		['read', ownFiles],
		['update', ownFiles],
	] as const) {
		await setupRequest(api.url)
			.post('/permissions')
			.set('Authorization', `Bearer ${api.adminToken}`)
			.send({ role: role.id, collection: 'directus_files', action, fields: ['*'], permissions, validation: {} })
			.expect(200);
	}

	await common.CreateUser(api, { token, email: `${token.toLowerCase()}@example.com`, role: role.id });

	const upload = await setupRequest(api.url)
		.post('/files')
		.set('Authorization', `Bearer ${token}`)
		.field('storage', 's3')
		.attach('file', createReadStream(imageFilePath))
		.expect(200);

	return upload.body.data.id as string;
}

describe('/assets', () => {
	describe('GET /assets/:id with a shared S3 connection pool', () => {
		test("keeps serving another tenant's assets after a burst of requests for a file that cannot be served", async ({
			api,
		}) => {
			const tenantA = 'PoolTenantAToken';
			const tenantB = 'PoolTenantBToken';
			const fileA = await createTenant(api, 'Pool Tenant A', tenantA);
			const fileB = await createTenant(api, 'Pool Tenant B', tenantB);

			await request(api.url)
				.patch(`/files/${fileA}`)
				.set('Authorization', `Bearer ${tenantA}`)
				.send({ type: UNSERVABLE_TYPE })
				.expect(200);

			const observations: Record<string, unknown> = {};
			let attack: { statusCodeStats: Record<string, { count: number }>; errors: number; timeouts: number } | undefined;
			let loadProcess: { status: number | null; signal: string | null; completed: unknown } | undefined;
			let victim: VictimOutcome | undefined;

			try {
				const attackStarted = Date.now();
				const url = `${api.url}/assets/${fileA}?access_token=${tenantA}`;

				const load = api.startNode(
					autocannon,
					['--json', '-c', '100', '-a', String(ATTACK_REQUESTS), '--timeout', '60', url],
					{ timeoutMs: 600_000 }
				);

				load.child.stdin!.end();
				const result = await load.result;
				const attackEnded = Date.now();

				observations['load'] = {
					status: result.status,
					signal: result.signal,
					durationMs: attackEnded - attackStarted,
				};

				const report = JSON.parse(result.stdout);
				loadProcess = { status: result.status, signal: result.signal, completed: report.requests?.total };
				attack = { statusCodeStats: report.statusCodeStats, errors: report.errors, timeouts: report.timeouts };
				observations['attack'] = { ...attack, completed: report.requests?.total };

				const victimStarted = Date.now();

				const probe = request(api.url)
					.get(`/assets/${fileB}`)
					.set('Authorization', `Bearer ${tenantB}`)
					.timeout(VICTIM_DEADLINE_MS * 2);

				let deadline: NodeJS.Timeout | undefined;

				try {
					victim = await Promise.race([
						probe.then(
							(res): VictimOutcome => ({
								kind: 'response',
								status: res.status,
								bodyMatches: Buffer.isBuffer(res.body) && res.body.equals(imageBytes),
							}),
							(error): VictimOutcome => ({ kind: 'transport error', message: error.message })
						),
						new Promise<VictimOutcome>((resolve) => {
							deadline = setTimeout(() => {
								probe.abort();
								resolve({ kind: 'client timeout' });
							}, VICTIM_DEADLINE_MS);
						}),
					]);
				} finally {
					clearTimeout(deadline);
				}

				observations['victim'] = {
					...victim,
					elapsedMs: Date.now() - victimStarted,
					gapSinceAttackMs: victimStarted - attackEnded,
				};
			} finally {
				await writeFile(
					join(inject('integration').directory, `${basename(api.directory)}-s3-pool-observations.json`),
					JSON.stringify(observations, null, 2)
				);
			}

			expect(victim).toEqual({ kind: 'response', status: 200, bodyMatches: true });
			expect(loadProcess).toEqual({ status: 0, signal: null, completed: ATTACK_REQUESTS });
			expect(attack).toEqual({ statusCodeStats: { '500': { count: ATTACK_REQUESTS } }, errors: 0, timeouts: 0 });

			await request(api.url)
				.patch(`/files/${fileA}`)
				.set('Authorization', `Bearer ${tenantA}`)
				.send({ type: 'image/png' })
				.expect(200);

			await request(api.url).get(`/assets/${fileA}`).set('Authorization', `Bearer ${tenantA}`).expect(200);
		}, 600_000);
	});
});
