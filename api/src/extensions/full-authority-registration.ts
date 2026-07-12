import * as sharedExceptions from '@cairncms/exceptions';
import type {
	ActionHandler,
	ApiExtensionContext,
	EmbedHandler,
	EndpointConfig,
	ExtensionSettingsReader,
	FilterHandler,
	HookConfig,
	InitHandler,
	OperationApiConfig,
	ScheduleHandler,
} from '@cairncms/types';
import express, { type Router } from 'express';
import { schedule, validate } from 'node-cron';
import getDatabase from '../database/index.js';
import type { Emitter } from '../emitter.js';
import emitter from '../emitter.js';
import env from '../env.js';
import * as exceptions from '../exceptions/index.js';
import { getFlowManager } from '../flows.js';
import logger from '../logger.js';
import * as services from '../services/index.js';
import type { EventHandler } from '../types/index.js';
import { getSchema } from '../utils/get-schema.js';

// The manager owns the mutable registration state and injects it here per call. This module
// creates none of it, so registration side effects stay visible in the coordinator.
export interface FullAuthorityRegistrationDeps {
	apiEmitter: Emitter;
	makeSettingsReader: (subject: string) => ExtensionSettingsReader;
	hookEvents: EventHandler[];
	hookEmbedsHead: string[];
	hookEmbedsBody: string[];
	scheduleEnabled: () => boolean;
	endpointRouter: Router;
	registeredEndpointRoutes: Set<string>;
}

function buildContext(
	deps: FullAuthorityRegistrationDeps,
	subject: string
): ApiExtensionContext & { emitter: Emitter } {
	return {
		services,
		exceptions: { ...exceptions, ...sharedExceptions },
		env,
		database: getDatabase(),
		emitter: deps.apiEmitter,
		logger,
		getSchema,
		extensionSettings: deps.makeSettingsReader(subject),
	};
}

export function registerHook(register: HookConfig, subject: string, deps: FullAuthorityRegistrationDeps): void {
	const registerFunctions = {
		filter: (event: string, handler: FilterHandler) => {
			emitter.onFilter(event, handler);

			deps.hookEvents.push({
				type: 'filter',
				name: event,
				handler,
			});
		},
		action: (event: string, handler: ActionHandler) => {
			emitter.onAction(event, handler);

			deps.hookEvents.push({
				type: 'action',
				name: event,
				handler,
			});
		},
		init: (event: string, handler: InitHandler) => {
			emitter.onInit(event, handler);

			deps.hookEvents.push({
				type: 'init',
				name: event,
				handler,
			});
		},
		schedule: (cron: string, handler: ScheduleHandler) => {
			if (validate(cron)) {
				const task = schedule(cron, async () => {
					if (deps.scheduleEnabled()) {
						try {
							await handler();
						} catch (error: any) {
							logger.error(error);
						}
					}
				});

				deps.hookEvents.push({
					type: 'schedule',
					task,
				});
			} else {
				logger.warn(`Couldn't register cron hook. Provided cron is invalid: ${cron}`);
			}
		},
		embed: (position: 'head' | 'body', code: string | EmbedHandler) => {
			const content = typeof code === 'function' ? code() : code;

			if (content.trim().length === 0) {
				logger.warn(`Couldn't register embed hook. Provided code is empty!`);
				return;
			}

			if (position === 'head') {
				deps.hookEmbedsHead.push(content);
			}

			if (position === 'body') {
				deps.hookEmbedsBody.push(content);
			}
		},
	};

	register(registerFunctions, buildContext(deps, subject));
}

export function registerEndpoint(
	config: EndpointConfig,
	name: string,
	subject: string,
	deps: FullAuthorityRegistrationDeps
): void {
	const register = typeof config === 'function' ? config : config.handler;
	const routeName = typeof config === 'function' ? name : config.id;

	const scopedRouter = express.Router();
	deps.endpointRouter.use(`/${routeName}`, scopedRouter);
	// Lowercased, because the router matches case-insensitively: a confined route
	// must collide with an inherited case variant, not shadow it.
	deps.registeredEndpointRoutes.add(routeName.toLowerCase());

	register(scopedRouter, buildContext(deps, subject));
}

export function registerOperation(
	config: OperationApiConfig,
	subject: string | undefined,
	deps: FullAuthorityRegistrationDeps
): void {
	const flowManager = getFlowManager();

	if (subject === undefined) {
		flowManager.addOperation(config.id, config.handler);
		return;
	}

	const extensionSettings = deps.makeSettingsReader(subject);

	flowManager.addOperation(config.id, (options, context) => config.handler(options, { ...context, extensionSettings }));
}
