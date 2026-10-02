import { expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Response } from 'supertest';
import type { Knex } from 'knex';
import type { Api } from '../fixtures/environment';
import request from '../fixtures/request';
import { delayedSleep, sleep } from '../utils/sleep';

type Env = Record<string, string>;
export const FLOW_MARKER = 'SCHEDULE_COORD_FLOW';
export const HOOK_MARKER = 'SCHEDULE_COORD_HOOK';

const FLOW_NAME_PREFIX = 'schedule-coord-';

export const COORD_FAIL = 'Schedule coordination failed';

export const COORD_UNAVAILABLE =
	'Schedule coordination is unavailable, so scheduled flows and extension hooks are disabled. They resume automatically when a supported Redis becomes reachable.';

export const COORD_RECOVERED =
	'Schedule coordination recovered, so scheduled flows and extension hooks are enabled again.';

export const MESSENGER_UNAVAILABLE =
	'The messenger connection is unavailable, so cross-instance cache and flow changes will not propagate until it recovers.';

export const MESSENGER_RECOVERED = 'The messenger connection recovered.';

const CRON = '*/2 * * * * *';

export const WINDOW_MS = 12000;
export const OUTAGE_MS = 8000;
export const SETTLE_MS = 3000;

// One continuous collector per process, attached at spawn and never detached, so no output is lost
// at a listener boundary. Windows mark a chunk offset and read forward from it.
export class Collector {
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

export function scheduleHelpers(api: Api) {
	const ADMIN = `Bearer ${api.adminToken}`;
	const urls = new WeakMap<Env, string>();
	const starts = new WeakMap<ChildProcess, Promise<unknown>>();

	function coordinatedEnv(_vendor: string, _offset: number, redisUrl: string, namespace: string): Env {
		return {
			MESSENGER_STORE: 'redis',
			MESSENGER_NAMESPACE: namespace,
			MESSENGER_REDIS: redisUrl,
			LOG_LEVEL: 'info',
			LOG_STYLE: 'raw',
			SCHEDULE_COORD_TEST: 'true',
		};
	}

	function coordinatedCacheEnv(vendor: string, offset: number, redisUrl: string, namespace: string): Env {
		return {
			...coordinatedEnv(vendor, offset, redisUrl, namespace),
			CACHE_ENABLED: 'true',
			CACHE_AUTO_PURGE: 'true',
			CACHE_SCHEMA: 'true',
			CACHE_STORE: 'memory',
			CACHE_NAMESPACE: `schedule-coord-cache-${namespace}`,
		};
	}

	function uncoordinatedEnv(_vendor: string, _offset: number): Env {
		return { MESSENGER_STORE: 'memory', LOG_LEVEL: 'info', LOG_STYLE: 'raw', SCHEDULE_COORD_TEST: 'true' };
	}

	function urlOf(_vendor: string, env: Env): string {
		const url = urls.get(env);
		if (!url) throw new Error('Scheduled companion has not completed readiness');
		return url;
	}

	function spawnInstance(env: Env, _vendor: string): ChildProcess {
		let child!: ChildProcess;

		const started = api
			.start(env, {
				onSpawn: (owned) => {
					child = owned;
				},
			})
			.then((result) => {
				urls.set(env, result.url);
			});

		void started.catch(() => undefined);
		if (!child) throw new Error('API spawn callback was not synchronous');
		starts.set(child, started);
		return child;
	}

	function awaitReady(child: ChildProcess) {
		const started = starts.get(child);
		if (!started) throw new Error('Unknown scheduled companion');
		return started;
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

	function collectionStatus(vendor: string, env: Env, collection: string): Promise<Response> {
		return request(urlOf(vendor, env)).get(`/collections/${collection}`).set('Authorization', ADMIN);
	}

	async function health(vendor: string, env: Env): Promise<Response> {
		return request(urlOf(vendor, env)).get('/server/health').set('Authorization', ADMIN);
	}

	async function pollHealthy(vendor: string, env: Env, timeoutMs: number): Promise<Response> {
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
	async function assertOneTransition(
		collector: Collector,
		mark: number,
		message: string,
		level: number
	): Promise<void> {
		await waitForRecords(collector, mark, message, 15000);
		const records = recordsWithMessage(collector.since(mark), message);
		expect(records).toHaveLength(1);
		expect(records[0]!.level).toBe(level);
	}

	return {
		ADMIN,
		coordinatedEnv,
		coordinatedCacheEnv,
		uncoordinatedEnv,
		urlOf,
		spawnInstance,
		awaitReady,
		seedFlow,
		recordTimes,
		recordsWithMessage,
		coordinatedPerOccurrence,
		observeWindow,
		observeFixed,
		collectionStatus,
		health,
		pollHealthy,
		pollForbidden,
		waitForRecords,
		assertOneTransition,
	};
}
