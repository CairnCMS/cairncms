import { expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import { createRedisTest } from '../fixtures/redis';
import { describeForVendors } from '../fixtures/applicability';
import { sleep } from '../utils/sleep';
import request from '../fixtures/request';
import { openRedisGate } from '../harness/redis-gate.mjs';
import {
	scheduleHelpers,
	Collector,
	FLOW_MARKER,
	HOOK_MARKER,
	COORD_UNAVAILABLE,
	COORD_RECOVERED,
	MESSENGER_UNAVAILABLE,
	MESSENGER_RECOVERED,
	OUTAGE_MS,
	SETTLE_MS,
} from './schedule-helpers';
import { initializeFixtures } from '../harness/fixture-setup.mjs';

initializeFixtures();

const test = createRedisTest('redis7', { extensions: ['cairncms-extension-schedule-hook'] });

describeForVendors(
	'Schedule coordination',
	['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
	'Multi-instance coordination needs a server database that several CairnCMS processes can share.',
	() => {
		test('Redis 7 recovers a never-connected startup, restores subscriptions, and recovers a runtime outage', async ({
			api,
			vendor,
			redis,
			cancellationSignal,
		}) => {
			const {
				ADMIN,
				coordinatedCacheEnv,
				urlOf,
				spawnInstance,
				awaitReady,
				seedFlow,
				recordTimes,
				observeWindow,
				observeFixed,
				collectionStatus,
				health,
				pollHealthy,
				pollForbidden,
				assertOneTransition,
			} = scheduleHelpers(api);

			const runId = uuid().slice(0, 8);
			const database = api.database;
			const flowId = uuid();
			const operationId = uuid();
			const collectionName = `schedule_coord_c_${runId}`;

			const children: ChildProcess[] = [];
			const gate = await openRedisGate(redis.url, cancellationSignal);
			let bodyFailed = false;
			let bodyError: unknown;

			const collectionPayload = {
				collection: collectionName,
				fields: [
					{
						field: 'id',
						type: 'integer',
						meta: { hidden: true, interface: 'input', readonly: true },
						schema: { is_primary_key: true, has_auto_increment: true },
					},
				],
				schema: {},
				meta: {},
			};

			try {
				await seedFlow(database, flowId, operationId, runId);

				const namespace7 = `schedule-coord-7-${vendor}-${runId}`;

				// F connects directly to Redis 7. E reaches an owned TCP gate that resets
				// connections without forwarding any bytes until recovery, so E has never reached Redis.
				const envF = coordinatedCacheEnv(vendor, 700, redis.url, namespace7);
				const envE = coordinatedCacheEnv(vendor, 750, gate.url, namespace7);

				const serverF = spawnInstance(envF, vendor);
				const serverE = spawnInstance(envE, vendor);
				children.push(serverF, serverE);

				const outE = new Collector(serverE);
				const errE = new Collector(serverE, 'stderr');

				await Promise.all([awaitReady(serverF), awaitReady(serverE)]);

				const ping = await request(urlOf(vendor, envE)).get('/server/ping');
				expect(ping.text).toBe('pong');

				const healthDown = await health(vendor, envE);
				expect(healthDown.statusCode).toBe(200);
				expect(healthDown.body.status).toBe('warn');
				expect(healthDown.body.checks['messenger:status'][0].status).toBe('warn');
				expect(healthDown.body.checks['scheduleCoordination:status'][0].status).toBe('warn');

				// Startup transition records are read from the process start (since 0), because a mark taken
				// after readiness would miss them. The ping and health calls above gave any duplicate time
				// to appear, so the final count is exactly one each.
				await assertOneTransition(outE, 0, COORD_UNAVAILABLE, 50);
				await assertOneTransition(outE, 0, MESSENGER_UNAVAILABLE, 40);

				const recoverMark = outE.mark();
				gate.enable();

				const healthUp = await pollHealthy(vendor, envE, 30000);
				expect(healthUp.body.checks['messenger:status'][0].status).toBe('ok');
				expect(healthUp.body.checks['scheduleCoordination:status'][0].status).toBe('ok');

				// pollHealthy has settled the recovery, so a final count of one confirms no recovery flap.
				await assertOneTransition(outE, recoverMark, COORD_RECOVERED, 30);
				await assertOneTransition(outE, recoverMark, MESSENGER_RECOVERED, 30);

				const createRes = await request(urlOf(vendor, envF))
					.post('/collections')
					.set('Authorization', ADMIN)
					.send(collectionPayload);

				expect(createRes.statusCode).toBe(200);

				// Prime E's response cache with the collection present. This first read caches E's 200 and
				// proves the precondition. E publishes no message of its own here, so the later forbidden
				// result is attributable only to F's delete crossing the messenger, not a fresh read of the
				// shared database (the response cache TTL is far longer than the poll below).
				const warm = await collectionStatus(vendor, envE, collectionName);
				expect(warm.statusCode).toBe(200);

				const deleteRes = await request(urlOf(vendor, envF))
					.delete(`/collections/${collectionName}`)
					.set('Authorization', ADMIN);

				expect(deleteRes.statusCode).toBe(204);

				expect(await pollForbidden(vendor, envE, collectionName, 15000)).toBe(403);

				await api.stop(serverF);

				const scheduled = await observeWindow([outE], [FLOW_MARKER, HOOK_MARKER]);

				for (const marker of [FLOW_MARKER, HOOK_MARKER]) {
					expect(recordTimes(scheduled[0]!, marker).length).toBeGreaterThanOrEqual(2);
				}

				const outageMark = outE.mark();
				gate.disable();

				// Let an occurrence admitted just before the outage finish before the zero-workload window.
				await sleep(SETTLE_MS);

				const [outageWindow] = await observeFixed([outE], OUTAGE_MS);
				expect(recordTimes(outageWindow, FLOW_MARKER).length).toBe(0);
				expect(recordTimes(outageWindow, HOOK_MARKER).length).toBe(0);

				// The reconnect storm across the settle and the window above gave any duplicate time to
				// appear, so the outage transitions read back as exactly one each.
				await assertOneTransition(outE, outageMark, COORD_UNAVAILABLE, 50);
				await assertOneTransition(outE, outageMark, MESSENGER_UNAVAILABLE, 40);

				const secondMark = outE.mark();
				const recoveryObservation = observeWindow([outE], [FLOW_MARKER, HOOK_MARKER]);
				gate.enable();
				const recovery = await recoveryObservation;

				for (const marker of [FLOW_MARKER, HOOK_MARKER]) {
					expect(recordTimes(recovery[0]!, marker).length).toBeGreaterThanOrEqual(2);
				}

				await assertOneTransition(outE, secondMark, COORD_RECOVERED, 30);
				await assertOneTransition(outE, secondMark, MESSENGER_RECOVERED, 30);

				expect(errE.since(0)).not.toContain('[ioredis]');
			} catch (error) {
				bodyFailed = true;
				bodyError = error;
			}

			await Promise.all(children.map((child) => api.stop(child)));
			await gate.close();

			const cleanupErrors: unknown[] = [];

			try {
				await database.schema.dropTableIfExists(collectionName);
			} catch (error) {
				cleanupErrors.push(error);
			}

			try {
				await database('directus_fields').where('collection', collectionName).del();
			} catch (error) {
				cleanupErrors.push(error);
			}

			try {
				await database('directus_collections').where('collection', collectionName).del();
			} catch (error) {
				cleanupErrors.push(error);
			}

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
