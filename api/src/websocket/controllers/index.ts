import type { SchemaOverview } from '@cairncms/types';
import type { Application } from 'express';
import type { Knex } from 'knex';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import logger from '../../logger.js';
import { consumeGlobalRateLimit } from '../../middleware/rate-limiter-global.js';
import { consumeIpRateLimit } from '../../middleware/rate-limiter-ip.js';
import type { Messenger } from '../../messenger.js';
import { Admission } from '../admission.js';
import { getWebSocketConfig, type WebSocketTransportConfig } from '../config.js';
import { DispatchCoordinator, resolveDeliveryConcurrency } from '../dispatch.js';
import { createUpgradeOriginPredicate } from '../origin.js';
import { SubscriptionRegistry } from '../subscriptions.js';
import {
	clearActiveRealtime,
	setActiveRealtime,
	type RealtimeAccess,
	type RealtimeControllerAccess,
} from './active.js';
import type { SocketClient, SocketController, SocketControllerOptions } from './base.js';
import { GraphQLController } from './graphql.js';
import { HookEventProducer } from './hooks.js';
import { WebSocketController } from './rest.js';

type TransportKey = 'rest' | 'graphql';

const LOG_ACTIVATION_FAILED = 'WebSocket realtime could not start; the realtime capability is unavailable';

export interface RealtimeDeps {
	app: Application;
	database: Knex;
	messenger: Messenger;
	getSchema: (options?: { database?: Knex }) => Promise<SchemaOverview>;
}

export interface RealtimeActivation {
	handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
	stop: () => Promise<void>;
}

function logConfigErrors(errors: readonly { message: string }[]): void {
	for (const error of errors) logger.error(error.message);
}

export async function activateRealtime(deps: RealtimeDeps): Promise<RealtimeActivation | null> {
	const resolution = getWebSocketConfig();

	if (!resolution.active) {
		logConfigErrors(resolution.errors);
		return null;
	}

	const transports: { key: TransportKey; config: WebSocketTransportConfig }[] = [];

	if (resolution.rest.active) transports.push({ key: 'rest', config: resolution.rest.config });
	else logConfigErrors(resolution.rest.errors);

	if (resolution.graphql.active) transports.push({ key: 'graphql', config: resolution.graphql.config });
	else logConfigErrors(resolution.graphql.errors);

	if (transports.length === 0) return null;

	const { shared } = resolution;

	let producer: HookEventProducer | null = null;
	let coordinator: DispatchCoordinator | null = null;
	const controllers: SocketController[] = [];

	try {
		const isOriginAllowed = createUpgradeOriginPredicate();

		const admission = new Admission({
			process: shared.processConnLimit,
			ip: shared.ipConnLimit,
			user: shared.userConnLimit,
			transports: Object.fromEntries(transports.map((transport) => [transport.key, transport.config.connLimit])),
		});

		const subscriptions = new SubscriptionRegistry();

		for (const transport of transports) {
			const options: SocketControllerOptions = {
				transport: transport.key,
				path: transport.config.path,
				authMode: transport.config.auth,
				authTimeoutMs: transport.config.authTimeoutMs,
				maxPayload: shared.maxPayload,
				heartbeatPeriodMs: shared.heartbeatPeriodMs,
				admission,
				isOriginAllowed,
				consumeIpRateLimit,
				consumeGlobalRateLimit,
				app: deps.app,
				database: deps.database,
				getSchema: deps.getSchema,
				subscriptions,
			};

			switch (transport.key) {
				case 'rest':
					controllers.push(new WebSocketController(options));
					break;
				case 'graphql':
					controllers.push(new GraphQLController(options));
					break;

				default: {
					const unreachable: never = transport.key;
					throw new Error(`Unknown WebSocket transport: ${String(unreachable)}`);
				}
			}
		}

		const activeProducer = new HookEventProducer(deps.messenger);
		producer = activeProducer;
		activeProducer.register();

		const activeCoordinator = new DispatchCoordinator({
			registry: subscriptions,
			getSchema: () => deps.getSchema({ database: deps.database }),
			messenger: deps.messenger,
			closeConnection: (client: SocketClient, code?: number) => {
				for (const controller of controllers) controller.closeConnection(client, code);
			},
			deliveryConcurrency: resolveDeliveryConcurrency(deps.database),
		});

		coordinator = activeCoordinator;
		activeCoordinator.start();

		const byTransport = new Map<string, RealtimeControllerAccess>();

		for (let index = 0; index < transports.length; index++) {
			const controller = controllers[index]!;

			byTransport.set(transports[index]!.key, {
				broadcast: (frame, filter) => controller.broadcast(frame, filter),
				clients: () => controller.clientSnapshot(),
			});
		}

		const access: RealtimeAccess = {
			transport: (key) => byTransport.get(key) ?? null,
			info: () => ({
				rest: resolution.rest.active
					? { authentication: resolution.rest.config.auth, path: resolution.rest.config.path }
					: false,
				graphql: resolution.graphql.active
					? { authentication: resolution.graphql.config.auth, path: resolution.graphql.config.path }
					: false,
				heartbeat: shared.heartbeatPeriodMs / 1000,
			}),
		};

		let stopPromise: Promise<void> | null = null;

		const stop = (): Promise<void> => {
			if (stopPromise === null) {
				clearActiveRealtime(access);

				stopPromise = (async () => {
					activeProducer.destroy();
					const coordinatorStop = activeCoordinator.stop();
					const controllerStops = controllers.map((controller) => controller.terminate());
					await Promise.all([coordinatorStop, ...controllerStops]);
				})();
			}

			return stopPromise;
		};

		setActiveRealtime(access);

		return {
			handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
				for (const controller of controllers) void controller.handleUpgrade(req, socket, head);
			},
			stop,
		};
	} catch {
		const cleanups: Promise<unknown>[] = [];

		try {
			producer?.destroy();
		} catch {
			// A cleanup failure never blocks the rest of the rollback.
		}

		if (coordinator) cleanups.push(Promise.resolve(coordinator.stop()).catch(() => undefined));
		for (const controller of controllers) cleanups.push(Promise.resolve(controller.terminate()).catch(() => undefined));

		await Promise.allSettled(cleanups);
		logger.error(LOG_ACTIVATION_FAILED);
		return null;
	}
}
