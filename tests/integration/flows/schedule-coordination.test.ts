import { expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import { createRedisTest } from '../fixtures/redis';
import { describeForVendors } from '../fixtures/applicability';
import { scheduleHelpers, Collector, FLOW_MARKER, HOOK_MARKER } from './schedule-helpers';
import { initializeFixtures } from '../harness/fixture-setup.mjs';

initializeFixtures();

const test = createRedisTest('redis6', { extensions: ['cairncms-extension-schedule-hook'] });

describeForVendors(
	'Schedule coordination',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'Multi-instance coordination needs a server database that several CairnCMS processes can share.',
	() => {
		test('Redis 6.2 admits once per occurrence cluster-wide and fails over to a standby', async ({
			api,
			vendor,
			redis,
		}) => {
			const {
				coordinatedEnv,
				uncoordinatedEnv,
				spawnInstance,
				awaitReady,
				seedFlow,
				coordinatedPerOccurrence,
				observeWindow,
			} = scheduleHelpers(api);

			const runId = uuid().slice(0, 8);
			const database = api.database;
			const flowId = uuid();
			const operationId = uuid();

			const children: ChildProcess[] = [];
			let bodyFailed = false;
			let bodyError: unknown;

			try {
				await seedFlow(database, flowId, operationId, runId);

				const namespace6 = `schedule-coord-6-${vendor}-${runId}`;
				const envA = coordinatedEnv(vendor, 550, redis.url.replace(/\/0$/, '/5'), namespace6);
				const envB = coordinatedEnv(vendor, 600, redis.url.replace(/\/0$/, '/5'), namespace6);
				const envC = uncoordinatedEnv(vendor, 650);

				const serverA = spawnInstance(envA, vendor);
				const serverB = spawnInstance(envB, vendor);
				const serverC = spawnInstance(envC, vendor);
				children.push(serverA, serverB, serverC);

				const collectorA = new Collector(serverA);
				const collectorB = new Collector(serverB);
				const collectorC = new Collector(serverC);

				await Promise.all([awaitReady(serverA), awaitReady(serverB), awaitReady(serverC)]);

				const part1 = await observeWindow([collectorA, collectorB, collectorC], [FLOW_MARKER, HOOK_MARKER]);

				for (const marker of [FLOW_MARKER, HOOK_MARKER]) {
					const perOccurrence = coordinatedPerOccurrence(part1[2]!, [part1[0]!, part1[1]!], marker);
					expect(perOccurrence.length).toBeGreaterThanOrEqual(3);
					for (const count of perOccurrence) expect(count).toBe(1);
				}

				await api.stop(serverA);

				const part2 = await observeWindow([collectorB, collectorC], [FLOW_MARKER]);
				const standbyPerOccurrence = coordinatedPerOccurrence(part2[1]!, [part2[0]!], FLOW_MARKER);
				expect(standbyPerOccurrence.length).toBeGreaterThanOrEqual(3);
				for (const count of standbyPerOccurrence) expect(count).toBe(1);
			} catch (error) {
				bodyFailed = true;
				bodyError = error;
			}

			await Promise.all(children.map((child) => api.stop(child)));

			const cleanupErrors: unknown[] = [];

			try {
				await database('directus_operations').where('id', operationId).del();
			} catch (error) {
				cleanupErrors.push(error);
			}

			try {
				await database('directus_flows').where('id', flowId).del();
			} catch (error) {
				cleanupErrors.push(error);
			}

			if (bodyFailed) cleanupErrors.unshift(bodyError);
			if (cleanupErrors.length === 1) throw cleanupErrors[0];
			if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Schedule case and cleanup failed');
		}, 600000);
	}
);
