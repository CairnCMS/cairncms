import config, { Env, paths } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { awaitDirectusConnection } from '@utils/await-connection';
import { delayedSleep, sleep } from '@utils/sleep';
import { ChildProcess, spawn } from 'child_process';
import knex, { Knex } from 'knex';
import { cloneDeep } from 'lodash';
import path from 'path';
import request from 'supertest';
import { v4 as uuid } from 'uuid';

// Multi-instance coordination needs a server database that several CairnCMS processes can share.
const supportedVendors = vendors.filter((vendor) => vendor !== 'sqlite3');
const describeFn = supportedVendors.length > 0 ? describe : describe.skip;

const FLOW_MARKER = 'SCHEDULE_COORD_FLOW';
const HOOK_MARKER = 'SCHEDULE_COORD_HOOK';
const FLOW_NAME_PREFIX = 'schedule-coord-';
const COORD_FAIL = 'Schedule coordination failed';

const COORD_UNAVAILABLE =
	'Schedule coordination is unavailable, so scheduled flows and extension hooks are disabled. They resume automatically when a supported Redis becomes reachable.';

const COORD_RECOVERED = 'Schedule coordination recovered, so scheduled flows and extension hooks are enabled again.';

const MESSENGER_UNAVAILABLE =
	'The messenger connection is unavailable, so cross-instance cache and flow changes will not propagate until it recovers.';

const MESSENGER_RECOVERED = 'The messenger connection recovered.';

const ADMIN = `Bearer ${common.USER.ADMIN.TOKEN}`;

const CRON = '*/2 * * * * *';
const WINDOW_MS = 12000;
const OUTAGE_MS = 8000;
const SETTLE_MS = 3000;

const REDIS6 = 'redis://127.0.0.1:6108/5';
const REDIS7_PORT = 6109;
// Redis 6.0 serves the messenger but rejects the ZADD GT probe, so coordination is unavailable while
// the messenger stays up. A compatibility fixture, not a supported store.
const REDIS60 = 'redis://127.0.0.1:6110/0';

const proxyScript = path.join(__dirname, '..', 'utils', 'redis-proxy.mjs');

// One continuous collector per process, attached at spawn and never detached, so no output is lost
// at a listener boundary. Windows mark a chunk offset and read forward from it.
class Collector {
	private chunks: string[] = [];
	private watchers: Array<(text: string) => void> = [];

	constructor(server: ChildProcess, stream: 'stdout' | 'stderr' = 'stdout') {
		server[stream]?.on('data', (chunk: unknown) => {
			const text = String(chunk);
			this.chunks.push(text);
			for (const watcher of this.watchers) watcher(text);
		});
	}

	mark(): number {
		return this.chunks.length;
	}

	since(mark: number): string {
		return this.chunks.slice(mark).join('');
	}

	watch(callback: (text: string) => void): () => void {
		this.watchers.push(callback);

		return () => {
			this.watchers = this.watchers.filter((watcher) => watcher !== callback);
		};
	}
}

function clearMessenger(block: Record<string, string>): void {
	for (const key of Object.keys(block)) {
		if (key.startsWith('MESSENGER_')) delete block[key];
	}
}

function coordinatedEnv(vendor: string, offset: number, redisUrl: string, namespace: string): Env {
	const env = cloneDeep(config.envs);
	const block = env[vendor as keyof Env]!;
	clearMessenger(block);
	block.PORT = String(Number(block.PORT) + offset);
	block.MESSENGER_STORE = 'redis';
	block.MESSENGER_NAMESPACE = namespace;
	block.MESSENGER_REDIS = redisUrl;
	block.LOG_LEVEL = 'info';
	block.LOG_STYLE = 'raw';
	block.SCHEDULE_COORD_TEST = 'true';
	return env;
}

// Enable response caching so a cross-instance schemaChanged message has observable stale state to clear.
function coordinatedCacheEnv(vendor: string, offset: number, redisUrl: string, namespace: string): Env {
	const env = coordinatedEnv(vendor, offset, redisUrl, namespace);
	const block = env[vendor as keyof Env]!;
	block.CACHE_ENABLED = 'true';
	block.CACHE_AUTO_PURGE = 'true';
	block.CACHE_SCHEMA = 'true';
	block.CACHE_STORE = 'memory';
	block.CACHE_NAMESPACE = `schedule-coord-cache-${namespace}`;
	return env;
}

function uncoordinatedEnv(vendor: string, offset: number): Env {
	const env = cloneDeep(config.envs);
	const block = env[vendor as keyof Env]!;
	clearMessenger(block);
	block.PORT = String(Number(block.PORT) + offset);
	block.LOG_LEVEL = 'info';
	block.LOG_STYLE = 'raw';
	block.SCHEDULE_COORD_TEST = 'true';
	return env;
}

function portOf(env: Env, vendor: string): number {
	return Number(env[vendor as keyof Env]!.PORT);
}

// The spawned instance URL from its own env. getUrl is deliberately not used: it rewrites the port
// under TEST_LOCAL and TEST_NO_CACHE, which would point assertions at the base API instead of E or F.
function urlOf(vendor: string, env: Env): string {
	return `http://127.0.0.1:${portOf(env, vendor)}`;
}

function spawnInstance(env: Env, vendor: string): ChildProcess {
	return spawn('node', ['--no-node-snapshot', paths.cli, 'start'], {
		cwd: paths.cwd,
		env: env[vendor as keyof Env],
	});
}

function awaitExit(child: ChildProcess): Promise<void> {
	return new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		child.once('exit', () => resolve());
	});
}

function spawnProxy(listenPort: number, upstreamPort: number): Promise<ChildProcess> {
	const proxy = spawn('node', [proxyScript, String(listenPort), String(upstreamPort)], { cwd: paths.cwd });

	return new Promise<ChildProcess>((resolve, reject) => {
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			proxy.kill();
			awaitExit(proxy).then(() => reject(new Error('redis proxy readiness timeout')));
		}, 10000);

		proxy.stdout?.on('data', (chunk: unknown) => {
			if (settled) return;

			if (String(chunk).includes('REDIS_PROXY_READY')) {
				settled = true;
				clearTimeout(timer);
				resolve(proxy);
			}
		});

		proxy.once('exit', () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error('redis proxy exited before ready'));
		});
	});
}

async function seedFlow(database: Knex, flowId: string, operationId: string, runId: string): Promise<void> {
	// Purge any leftover coordination flows from an interrupted prior run (the cascade removes their
	// operations) so instances load exactly this run's flow.
	await database('directus_flows').where('name', 'like', `${FLOW_NAME_PREFIX}%`).del();

	await database('directus_flows').insert({
		id: flowId,
		name: `${FLOW_NAME_PREFIX}${runId}`,
		status: 'active',
		trigger: 'schedule',
		accountability: null,
		options: JSON.stringify({ cron: CRON }),
		operation: operationId,
	});

	await database('directus_operations').insert({
		id: operationId,
		key: 'log',
		type: 'log',
		position_x: 1,
		position_y: 1,
		options: JSON.stringify({ message: FLOW_MARKER }),
		flow: flowId,
	});
}

function recordTimes(buffer: string, marker: string): number[] {
	const times: number[] = [];

	for (const line of buffer.split('\n')) {
		if (!line.includes(marker)) continue;

		let parsed: { msg?: unknown; time?: unknown };

		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

		if (parsed.msg === marker && typeof parsed.time === 'number') times.push(parsed.time);
	}

	return times;
}

function recordsWithMessage(buffer: string, message: string): Array<{ level?: unknown; msg?: unknown }> {
	const records: Array<{ level?: unknown; msg?: unknown }> = [];

	for (const line of buffer.split('\n')) {
		if (!line.includes(message)) continue;

		let parsed: { level?: unknown; msg?: unknown };

		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

		if (parsed.msg === message) records.push(parsed);
	}

	return records;
}

function coordinatedPerOccurrence(controlBuffer: string, coordinatedBuffers: string[], marker: string): number[] {
	const control = recordTimes(controlBuffer, marker).sort((a, b) => a - b);
	const coordinated = coordinatedBuffers.flatMap((buffer) => recordTimes(buffer, marker));

	const counts: number[] = [];

	for (let i = 1; i < control.length - 1; i++) {
		const lower = (control[i - 1]! + control[i]!) / 2;
		const upper = (control[i]! + control[i + 1]!) / 2;
		counts.push(coordinated.filter((time) => time >= lower && time < upper).length);
	}

	return counts;
}

// Arm synchronously (mark each collector, start watching for the trigger), then resolve with each
// collector's output once the window closes. Callers arm before any action that could emit early.
function observeWindow(collectors: Collector[], triggers: string[]): Promise<string[]> {
	const marks = collectors.map((collector) => collector.mark());
	const window = delayedSleep(WINDOW_MS);

	const unwatchers = collectors.map((collector) =>
		collector.watch((text) => {
			if (triggers.some((marker) => text.includes(marker))) window.start();
		})
	);

	// Safety cap if no marker ever triggers the window. Cleared on resolution so it neither hangs (it
	// stays referenced until then) nor leaks a timer that keeps Jest alive after the test.
	let capTimer: ReturnType<typeof setTimeout>;

	const cap = new Promise<void>((resolve) => {
		capTimer = setTimeout(resolve, WINDOW_MS + 15000);
	});

	return Promise.race([window.finished, cap]).then(() => {
		clearTimeout(capTimer);
		window.cancel();
		for (const unwatch of unwatchers) unwatch();
		return collectors.map((collector, index) => collector.since(marks[index]!));
	});
}

function observeFixed(collectors: Collector[], ms: number): Promise<string[]> {
	const marks = collectors.map((collector) => collector.mark());
	return sleep(ms).then(() => collectors.map((collector, index) => collector.since(marks[index]!)));
}

function collectionStatus(vendor: string, env: Env, collection: string): Promise<request.Response> {
	return request(urlOf(vendor, env)).get(`/collections/${collection}`).set('Authorization', ADMIN);
}

async function health(vendor: string, env: Env): Promise<request.Response> {
	return request(urlOf(vendor, env)).get('/server/health').set('Authorization', ADMIN);
}

async function pollHealthy(vendor: string, env: Env, timeoutMs: number): Promise<request.Response> {
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		const response = await health(vendor, env);
		const checks = response.body?.checks ?? {};
		const messengerOk = checks['messenger:status']?.[0]?.status === 'ok';
		const coordinationOk = checks['scheduleCoordination:status']?.[0]?.status === 'ok';

		if (messengerOk && coordinationOk) return response;
		if (Date.now() >= deadline) return response;
		await sleep(250);
	}
}

async function pollForbidden(vendor: string, env: Env, collection: string, timeoutMs: number): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	let last = 0;

	for (;;) {
		const response = await collectionStatus(vendor, env, collection);
		last = response.statusCode;
		if (last === 403) return 403;
		if (Date.now() >= deadline) return last;
		await sleep(250);
	}
}

// A transition record and the state it reports are set together, but pino flushes the line
// asynchronously, so poll the collector until the record appears rather than reading once.
async function waitForRecords(
	collector: Collector,
	mark: number,
	message: string,
	timeoutMs: number
): Promise<Array<{ level?: unknown; msg?: unknown }>> {
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		const records = recordsWithMessage(collector.since(mark), message);
		if (records.length >= 1) return records;
		if (Date.now() >= deadline) return records;
		await sleep(200);
	}
}

// Await the first record so the assertion never races the pino flush, then re-read the whole marked
// phase and assert the final count is exactly one at the given level, so a later duplicate (a broken
// dedup, a flap) is caught. Call it only after the phase's own observation window has closed.
async function assertOneTransition(collector: Collector, mark: number, message: string, level: number): Promise<void> {
	await waitForRecords(collector, mark, message, 15000);
	const records = recordsWithMessage(collector.since(mark), message);
	expect(records).toHaveLength(1);
	expect(records[0]!.level).toBe(level);
}

describeFn('Schedule coordination', () => {
	it.each(supportedVendors)(
		'%s: Redis 6.2 admits once per occurrence cluster-wide and fails over to a standby',
		async (vendor) => {
			const runId = uuid().slice(0, 8);
			const database = knex(config.knexConfig[vendor]!);
			const flowId = uuid();
			const operationId = uuid();

			const children: ChildProcess[] = [];
			let bodyFailed = false;
			let bodyError: unknown;

			try {
				await seedFlow(database, flowId, operationId, runId);

				const namespace6 = `schedule-coord-6-${vendor}-${runId}`;
				const envA = coordinatedEnv(vendor, 550, REDIS6, namespace6);
				const envB = coordinatedEnv(vendor, 600, REDIS6, namespace6);
				const envC = uncoordinatedEnv(vendor, 650);

				const serverA = spawnInstance(envA, vendor);
				const serverB = spawnInstance(envB, vendor);
				const serverC = spawnInstance(envC, vendor);
				children.push(serverA, serverB, serverC);

				const collectorA = new Collector(serverA);
				const collectorB = new Collector(serverB);
				const collectorC = new Collector(serverC);

				await Promise.all([
					awaitDirectusConnection(portOf(envA, vendor), serverA),
					awaitDirectusConnection(portOf(envB, vendor), serverB),
					awaitDirectusConnection(portOf(envC, vendor), serverC),
				]);

				const part1 = await observeWindow([collectorA, collectorB, collectorC], [FLOW_MARKER, HOOK_MARKER]);

				for (const marker of [FLOW_MARKER, HOOK_MARKER]) {
					const perOccurrence = coordinatedPerOccurrence(part1[2]!, [part1[0]!, part1[1]!], marker);
					expect(perOccurrence.length).toBeGreaterThanOrEqual(3);
					for (const count of perOccurrence) expect(count).toBe(1);
				}

				serverA.kill();
				await awaitExit(serverA);

				const part2 = await observeWindow([collectorB, collectorC], [FLOW_MARKER]);
				const standbyPerOccurrence = coordinatedPerOccurrence(part2[1]!, [part2[0]!], FLOW_MARKER);
				expect(standbyPerOccurrence.length).toBeGreaterThanOrEqual(3);
				for (const count of standbyPerOccurrence) expect(count).toBe(1);
			} catch (error) {
				bodyFailed = true;
				bodyError = error;
			}

			for (const child of children) child.kill();
			await Promise.all(children.map(awaitExit));

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

			try {
				await database.destroy();
			} catch (error) {
				cleanupErrors.push(error);
			}

			if (bodyFailed) throw bodyError;
			if (cleanupErrors.length > 0) throw cleanupErrors[0];
		},
		600000
	);

	it.each(supportedVendors)(
		'%s: Redis 6.0 disables scheduling while the messenger and API stay up',
		async (vendor) => {
			const runId = uuid().slice(0, 8);
			const database = knex(config.knexConfig[vendor]!);
			const flowId = uuid();
			const operationId = uuid();

			const children: ChildProcess[] = [];
			let bodyFailed = false;
			let bodyError: unknown;

			try {
				await seedFlow(database, flowId, operationId, runId);

				// An uncoordinated control proves the flow and hook fixtures are live: it must fire both.
				const envControl = uncoordinatedEnv(vendor, 800);
				const envUnavailable = coordinatedEnv(vendor, 850, REDIS60, `schedule-coord-unavailable-${vendor}-${runId}`);

				const control = spawnInstance(envControl, vendor);
				const unavailable = spawnInstance(envUnavailable, vendor);
				children.push(control, unavailable);

				const controlOut = new Collector(control);
				const unavailableOut = new Collector(unavailable);
				const unavailableErr = new Collector(unavailable, 'stderr');

				await Promise.all([
					awaitDirectusConnection(portOf(envControl, vendor), control),
					awaitDirectusConnection(portOf(envUnavailable, vendor), unavailable),
				]);

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

			for (const child of children) child.kill();
			await Promise.all(children.map(awaitExit));

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

			try {
				await database.destroy();
			} catch (error) {
				cleanupErrors.push(error);
			}

			if (bodyFailed) throw bodyError;
			if (cleanupErrors.length > 0) throw cleanupErrors[0];
		},
		600000
	);

	it.each(supportedVendors)(
		'%s: Redis 7 recovers a never-connected startup, restores subscriptions, and recovers a runtime outage',
		async (vendor) => {
			const runId = uuid().slice(0, 8);
			const database = knex(config.knexConfig[vendor]!);
			const flowId = uuid();
			const operationId = uuid();
			const collectionName = `schedule_coord_c_${runId}`;

			const children: ChildProcess[] = [];
			let proxy: ChildProcess | undefined;
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
				const proxyPort = Number(config.envs[vendor as keyof Env]!.PORT) + 900;

				// F connects directly to Redis 7. E points at a proxy port with nothing listening, so E is
				// never-connected at startup while F is healthy.
				const envF = coordinatedCacheEnv(vendor, 700, `redis://127.0.0.1:${REDIS7_PORT}/0`, namespace7);
				const envE = coordinatedCacheEnv(vendor, 750, `redis://127.0.0.1:${proxyPort}/0`, namespace7);

				const serverF = spawnInstance(envF, vendor);
				const serverE = spawnInstance(envE, vendor);
				children.push(serverF, serverE);

				const outE = new Collector(serverE);
				const errE = new Collector(serverE, 'stderr');

				await Promise.all([
					awaitDirectusConnection(portOf(envF, vendor), serverF),
					awaitDirectusConnection(portOf(envE, vendor), serverE),
				]);

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
				proxy = await spawnProxy(proxyPort, REDIS7_PORT);

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

				serverF.kill();
				await awaitExit(serverF);

				const scheduled = await observeWindow([outE], [FLOW_MARKER, HOOK_MARKER]);

				for (const marker of [FLOW_MARKER, HOOK_MARKER]) {
					expect(recordTimes(scheduled[0]!, marker).length).toBeGreaterThanOrEqual(2);
				}

				const outageMark = outE.mark();
				proxy.kill();
				await awaitExit(proxy);
				proxy = undefined;

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
				proxy = await spawnProxy(proxyPort, REDIS7_PORT);
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

			for (const child of children) child.kill();
			if (proxy) proxy.kill();
			await Promise.all(children.map(awaitExit));
			if (proxy) await awaitExit(proxy);

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

			try {
				await database.destroy();
			} catch (error) {
				cleanupErrors.push(error);
			}

			if (bodyFailed) throw bodyError;
			if (cleanupErrors.length > 0) throw cleanupErrors[0];
		},
		600000
	);
});
