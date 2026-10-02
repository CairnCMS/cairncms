import { expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import { createRedisTest } from '../fixtures/redis';
import { describeForVendors } from '../fixtures/applicability';
import request from '../fixtures/request';
import {
	scheduleHelpers,
	Collector,
	FLOW_MARKER,
	HOOK_MARKER,
	COORD_FAIL,
	COORD_UNAVAILABLE,
	WINDOW_MS,
} from './schedule-helpers';
import { initializeFixtures } from '../harness/fixture-setup.mjs';

initializeFixtures();

const test = createRedisTest('redis60', { extensions: ['cairncms-extension-schedule-hook'] });

describeForVendors(
	'Schedule coordination',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'Multi-instance coordination needs a server database that several CairnCMS processes can share.',
	() => {
		test('Redis 6.0 disables scheduling while the messenger and API stay up', async ({ api, vendor, redis }) => {
			const {
				coordinatedEnv,
				uncoordinatedEnv,
				urlOf,
				spawnInstance,
				awaitReady,
				seedFlow,
				recordTimes,
				recordsWithMessage,
				observeFixed,
				health,
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

				// An uncoordinated control proves the flow and hook fixtures are live: it must fire both.
				const envControl = uncoordinatedEnv(vendor, 800);
				const envUnavailable = coordinatedEnv(vendor, 850, redis.url, `schedule-coord-unavailable-${vendor}-${runId}`);

				const control = spawnInstance(envControl, vendor);
				const unavailable = spawnInstance(envUnavailable, vendor);
				children.push(control, unavailable);

				const controlOut = new Collector(control);
				const unavailableOut = new Collector(unavailable);
				const unavailableErr = new Collector(unavailable, 'stderr');

				await Promise.all([awaitReady(control), awaitReady(unavailable)]);

				const [controlWindow, unavailableWindow] = await observeFixed([controlOut, unavailableOut], WINDOW_MS);

				for (const marker of [FLOW_MARKER, HOOK_MARKER]) {
					expect(recordTimes(controlWindow, marker).length).toBeGreaterThanOrEqual(3);
					expect(recordTimes(unavailableWindow, marker).length).toBe(0);
				}

				expect(unavailableWindow).not.toContain(COORD_FAIL);

				const ping = await request(urlOf(vendor, envUnavailable)).get('/server/ping');
				expect(ping.text).toBe('pong');

				const disabled = recordsWithMessage(unavailableOut.since(0), COORD_UNAVAILABLE);
				expect(disabled).toHaveLength(1);
				expect(disabled[0]!.level).toBe(50);

				const status = await health(vendor, envUnavailable);
				expect(status.statusCode).toBe(200);
				expect(status.body.status).toBe('warn');
				expect(status.body.checks['messenger:status'][0].status).toBe('ok');
				expect(status.body.checks['scheduleCoordination:status'][0].status).toBe('warn');

				expect(unavailableErr.since(0)).not.toContain('[ioredis]');
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
