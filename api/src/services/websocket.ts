import type { ActionHandler } from '@cairncms/types';
import emitter from '../emitter.js';
import { ServiceUnavailableException } from '../exceptions/index.js';
import type { SocketClient } from '../websocket/controllers/base.js';
import { getActiveRealtime, type RealtimeControllerAccess } from '../websocket/controllers/active.js';
import type { WebSocketMessage } from '../websocket/messages.js';

type WebSocketLifecycleEvent = 'connect' | 'message' | 'error' | 'close';

const SERVICE_UNAVAILABLE = 'The realtime WebSocket service is unavailable.';

export class WebSocketService {
	on(event: WebSocketLifecycleEvent, callback: ActionHandler): void {
		emitter.onAction(`websocket.${event}`, callback);
	}

	off(event: WebSocketLifecycleEvent, callback: ActionHandler): void {
		emitter.offAction(`websocket.${event}`, callback);
	}

	broadcast(message: string | WebSocketMessage, filter?: { user?: string; role?: string }): void {
		const frame = typeof message === 'string' ? message : JSON.stringify(message);
		this.requireRest().broadcast(frame, filter);
	}

	clients(): Set<SocketClient> {
		return this.requireRest().clients();
	}

	private requireRest(): RealtimeControllerAccess {
		const rest = getActiveRealtime()?.transport('rest') ?? null;

		if (rest === null) {
			throw new ServiceUnavailableException(SERVICE_UNAVAILABLE, { service: 'websocket' });
		}

		return rest;
	}
}
