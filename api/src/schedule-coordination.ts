import { Redis, type RedisOptions } from 'ioredis';
import type { RunCoordinator } from 'node-cron';
import env from './env.js';
import logger from './logger.js';
import { getConfigFromEnv } from './utils/get-config-from-env.js';

const READINESS_DEADLINE_MS = 10_000;
const CLAIM_DEADLINE_MS = 5_000;
const OCCURRENCE_ISO_LENGTH = 24;
const PROBE_MEMBER = '__probe__';
const PROBE_SCORE = 0;

export type ScheduleCoordinationStatus = 'inactive' | 'ready' | 'unavailable';

export const SCHEDULE_COORDINATION_UNAVAILABLE =
	'Schedule coordination is unavailable, so scheduled flows and extension hooks are disabled. They resume automatically when a supported Redis becomes reachable.';

export const SCHEDULE_COORDINATION_RECOVERED =
	'Schedule coordination recovered, so scheduled flows and extension hooks are enabled again.';

export const SCHEDULE_COORDINATION_CONFIG_INVALID =
	'Schedule coordination is disabled because the messenger Redis configuration is invalid. Correct the configuration and restart the API.';

const INIT_SUPERSEDED = 'Schedule coordination initialization was superseded.';

const FAIL_CLOSED_OPTIONS: RedisOptions = {
	enableOfflineQueue: false,
	autoResendUnfulfilledCommands: false,
	maxRetriesPerRequest: 0,
};

let state: 'uninitialized' | ScheduleCoordinationStatus = 'uninitialized';
let client: Redis | undefined;
let namespace: string | undefined;
let initPromise: Promise<ScheduleCoordinationStatus> | undefined;
let initGeneration = 0;
let probeGeneration = 0;
let connected = false;
let degraded = false;
let recovering = false;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let recoveryAttempt = 0;
let firstSettle: (() => void) | undefined;

export function isCoordinationEnabled(): boolean {
	return env['MESSENGER_STORE'] === 'redis';
}

function buildClient(): Redis {
	const url = env['MESSENGER_REDIS'];

	const built =
		typeof url === 'string'
			? new Redis(url, FAIL_CLOSED_OPTIONS)
			: new Redis({ ...getConfigFromEnv('MESSENGER_REDIS'), ...FAIL_CLOSED_OPTIONS });

	// ioredis prints unhandled errors directly to stderr, bypassing the platform logger.
	built.on('error', () => undefined);

	return built;
}

function claimSetKey(ns: string): string {
	return `${ns}:schedule-coordination`;
}

function markReady(): void {
	state = 'ready';
	recoveryAttempt = 0;
	clearRecoveryTimer();

	if (degraded) {
		degraded = false;
		logger.info(SCHEDULE_COORDINATION_RECOVERED);
	}
}

function markUnavailable(): void {
	state = 'unavailable';

	if (!degraded) {
		degraded = true;
		logger.error(SCHEDULE_COORDINATION_UNAVAILABLE);
	}
}

function settleInit(generation: number): void {
	if (generation !== initGeneration) return;
	const settle = firstSettle;
	firstSettle = undefined;
	settle?.();
}

function clearRecoveryTimer(): void {
	if (recoveryTimer) {
		clearTimeout(recoveryTimer);
		recoveryTimer = undefined;
	}
}

function scheduleRecovery(): void {
	if (recoveryTimer || recovering || !connected) return;

	recoveryAttempt++;
	const delay = Math.min(recoveryAttempt * 50, 2_000);

	recoveryTimer = setTimeout(() => {
		recoveryTimer = undefined;
		void attemptProbe();
	}, delay);
}

async function attemptProbe(): Promise<void> {
	if (recovering || !connected) return;

	const active = client;
	const ns = namespace;

	if (!active || ns === undefined) return;

	recovering = true;
	const generation = probeGeneration;
	const initGen = initGeneration;

	// Probe the live claim key so key-scoped ACLs prove scheduling can write its storage.
	const probeCommand = active.zadd(claimSetKey(ns), 'GT', 'CH', PROBE_SCORE, PROBE_MEMBER);
	let timer: ReturnType<typeof setTimeout> | undefined;

	// Recycling a stalled probe flushes it and lets reconnect trigger a fresh probe.
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			active.disconnect(true);
			reject(new Error(`capability probe timed out after ${CLAIM_DEADLINE_MS}ms`));
		}, CLAIM_DEADLINE_MS);
	});

	try {
		await Promise.race([probeCommand, deadline]);
		if (generation === probeGeneration) markReady();
	} catch {
		if (generation === probeGeneration) markUnavailable();
	} finally {
		if (timer) clearTimeout(timer);
		probeCommand.catch(() => undefined);
		settleInit(initGen);

		// A superseded probe cannot release or reschedule the current generation's work.
		if (generation === probeGeneration) {
			recovering = false;
			if (state !== 'ready' && connected) scheduleRecovery();
		}
	}
}

function onReady(target: Redis): void {
	if (target !== client) return;
	connected = true;
	recoveryAttempt = 0;
	clearRecoveryTimer();
	void attemptProbe();
}

function onDown(target: Redis): void {
	if (target !== client) return;
	connected = false;
	recovering = false;
	probeGeneration++;
	clearRecoveryTimer();
	markUnavailable();
	settleInit(initGeneration);
}

function attachRecoveryListeners(target: Redis): void {
	target.on('ready', () => onReady(target));
	target.on('close', () => onDown(target));
	target.on('end', () => onDown(target));
}

async function runInit(generation: number): Promise<void> {
	namespace = env['MESSENGER_NAMESPACE'] ?? 'cairncms';

	try {
		client = buildClient();
	} catch {
		// Construction failures cannot recover in-process or use the runtime-recovery message.
		if (generation === initGeneration) {
			state = 'unavailable';
			degraded = true;
			logger.error(SCHEDULE_COORDINATION_CONFIG_INVALID);
		}

		return;
	}

	attachRecoveryListeners(client);

	await new Promise<void>((resolve) => {
		let done = false;

		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(deadline);
			resolve();
		};

		const deadline = setTimeout(() => {
			if (generation === initGeneration && state === 'uninitialized') markUnavailable();
			finish();
		}, READINESS_DEADLINE_MS);

		firstSettle = finish;
	});
}

export function initScheduleCoordination(): Promise<ScheduleCoordinationStatus> {
	if (!isCoordinationEnabled()) {
		state = 'inactive';
		return Promise.resolve('inactive');
	}

	if (state === 'ready' || state === 'unavailable') return Promise.resolve(state);
	if (initPromise) return initPromise;

	const generation = initGeneration;

	initPromise = runInit(generation).then((): ScheduleCoordinationStatus => {
		if (generation !== initGeneration || (state !== 'ready' && state !== 'unavailable')) {
			throw new Error(INIT_SUPERSEDED);
		}

		initPromise = undefined;
		return state;
	});

	return initPromise;
}

export function getScheduleCoordinationStatus(): ScheduleCoordinationStatus {
	if (!isCoordinationEnabled()) return 'inactive';
	return state === 'uninitialized' ? 'unavailable' : state;
}

export class ScheduleCoordinationError extends Error {
	readonly scheduleId: string;
	readonly occurrence: number | undefined;

	constructor(scheduleId: string, occurrence?: number) {
		super('Schedule coordination failed');
		this.name = 'ScheduleCoordinationError';
		this.scheduleId = scheduleId;
		this.occurrence = occurrence;
	}
}

// Claims are never released because another replica could rerun the same occurrence.
export function createRunCoordinator(scheduleId: string): RunCoordinator {
	return {
		async shouldRun(key: string): Promise<boolean> {
			// Never fall back to local execution while coordination is unavailable.
			if (state === 'unavailable') return false;

			const suffix = key.slice(-OCCURRENCE_ISO_LENGTH);
			const occurrence = Date.parse(suffix);

			if (!Number.isFinite(occurrence) || new Date(occurrence).toISOString() !== suffix) {
				throw new ScheduleCoordinationError(scheduleId);
			}

			// A missing client here indicates an internal initialization-order violation.
			const active = client;
			const ns = namespace;

			if (!active || ns === undefined) {
				throw new ScheduleCoordinationError(scheduleId, occurrence);
			}

			const claim = active.zadd(claimSetKey(ns), 'GT', 'CH', occurrence, scheduleId);
			let timer: ReturnType<typeof setTimeout> | undefined;

			// Recycling flushes a stalled command instead of leaving later claims queued behind it.
			const deadline = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					active.disconnect(true);
					reject(new Error(`claim timed out after ${CLAIM_DEADLINE_MS}ms`));
				}, CLAIM_DEADLINE_MS);
			});

			try {
				const changed = await Promise.race([claim, deadline]);
				return Number(changed) === 1;
			} catch {
				// Claim failures suppress later occurrences until the capability probe succeeds.
				if (connected) {
					markUnavailable();
					scheduleRecovery();
				}

				throw new ScheduleCoordinationError(scheduleId, occurrence);
			} finally {
				if (timer) clearTimeout(timer);
				claim.catch(() => undefined);
			}
		},
	};
}

export function destroyScheduleCoordination(): void {
	initGeneration++;
	probeGeneration++;
	connected = false;
	recovering = false;
	recoveryAttempt = 0;
	clearRecoveryTimer();

	const settle = firstSettle;
	firstSettle = undefined;
	settle?.();

	if (client) {
		client.disconnect();
		client = undefined;
	}

	namespace = undefined;
	state = 'uninitialized';
	initPromise = undefined;
	degraded = false;
}
