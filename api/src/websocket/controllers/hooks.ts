import type { ActionHandler } from '@cairncms/types';
import { isInternalTable } from '../../database/internal-tables.js';
import emitter from '../../emitter.js';
import { getMessenger, type Messenger } from '../../messenger.js';
import type { WebSocketEvent } from '../messages.js';

const SUPPORTED_SCOPES = ['items', 'dashboards', 'notifications', 'operations', 'panels', 'shares'] as const;

export class HookEventProducer {
	private readonly messenger: Messenger;
	private readonly listeners: Array<[string, ActionHandler]> = [];

	constructor(messenger: Messenger = getMessenger()) {
		this.messenger = messenger;
	}

	register(): void {
		for (const scope of SUPPORTED_SCOPES) {
			this.on(`${scope}.create`, (meta) => ({ action: 'create', collection: meta['collection'], key: meta['key'] }));
			this.on(`${scope}.update`, (meta) => ({ action: 'update', collection: meta['collection'], keys: meta['keys'] }));
			this.on(`${scope}.delete`, (meta) => ({ action: 'delete', collection: meta['collection'], keys: meta['keys'] }));
		}

		this.on('items.sort', (meta) => ({ action: 'update', collection: meta['collection'], keys: [meta['item']] }));
	}

	destroy(): void {
		for (const [event, handler] of this.listeners) emitter.offAction(event, handler);
		this.listeners.length = 0;
	}

	private on(event: string, transform: (meta: Record<string, any>) => WebSocketEvent): void {
		const handler: ActionHandler = (meta) => {
			const wsEvent = transform(meta);
			if (isInternalTable(wsEvent.collection)) return;
			this.messenger.publish('websocket.event', wsEvent as Record<string, any>);
		};

		emitter.onAction(event, handler);
		this.listeners.push([event, handler]);
	}
}
