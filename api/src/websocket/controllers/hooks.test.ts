import type { EventContext } from '@cairncms/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import emitter from '../../emitter.js';
import type { Messenger } from '../../messenger.js';
import { HookEventProducer } from './hooks.js';

const CONTEXT = { database: {}, schema: null, accountability: null } as unknown as EventContext;

let active: HookEventProducer | null = null;

function makeProducer() {
	const publish = vi.fn();
	const messenger = { publish, subscribe: vi.fn(), unsubscribe: vi.fn(), getStatus: vi.fn() } as unknown as Messenger;
	const producer = new HookEventProducer(messenger);
	producer.register();
	active = producer;
	return { producer, publish };
}

afterEach(() => {
	active?.destroy();
	active = null;
});

describe('HookEventProducer', () => {
	it('publishes create, update, and delete for a user collection', () => {
		const { publish } = makeProducer();

		emitter.emitAction('items.create', { collection: 'articles', key: 1 }, CONTEXT);
		emitter.emitAction('items.update', { collection: 'articles', keys: [1, 2] }, CONTEXT);
		emitter.emitAction('items.delete', { collection: 'articles', keys: [3] }, CONTEXT);

		expect(publish).toHaveBeenCalledWith('websocket.event', { action: 'create', collection: 'articles', key: 1 });
		expect(publish).toHaveBeenCalledWith('websocket.event', { action: 'update', collection: 'articles', keys: [1, 2] });
		expect(publish).toHaveBeenCalledWith('websocket.event', { action: 'delete', collection: 'articles', keys: [3] });
	});

	it('publishes a supported system collection event by its scope', () => {
		const { publish } = makeProducer();

		emitter.emitAction('dashboards.create', { collection: 'directus_dashboards', key: 'd1' }, CONTEXT);

		expect(publish).toHaveBeenCalledWith('websocket.event', {
			action: 'create',
			collection: 'directus_dashboards',
			key: 'd1',
		});
	});

	it('maps item-sort to an update naming only the moved key', () => {
		const { publish } = makeProducer();

		emitter.emitAction('items.sort', { collection: 'articles', item: 5, to: 2 }, CONTEXT);

		expect(publish).toHaveBeenCalledWith('websocket.event', { action: 'update', collection: 'articles', keys: [5] });
	});

	it('does not publish an internal-table mutation', () => {
		const { publish } = makeProducer();

		emitter.emitAction('items.create', { collection: 'cairncms_extension_settings', key: 1 }, CONTEXT);

		expect(publish).not.toHaveBeenCalled();
	});

	it('does not register unsupported modules', () => {
		const { publish } = makeProducer();

		emitter.emitAction('users.create', { collection: 'directus_users', key: 1 }, CONTEXT);
		emitter.emitAction('folders.create', { collection: 'directus_folders', key: 1 }, CONTEXT);

		expect(publish).not.toHaveBeenCalled();
	});

	it('removes every listener on destroy', () => {
		const { producer, publish } = makeProducer();
		producer.destroy();

		emitter.emitAction('items.create', { collection: 'articles', key: 1 }, CONTEXT);

		expect(publish).not.toHaveBeenCalled();
	});
});
