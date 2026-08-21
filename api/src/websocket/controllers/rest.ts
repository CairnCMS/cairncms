import { handleItems } from '../handlers/items.js';
import { handleSubscription } from '../handlers/subscribe.js';
import { SocketController, type SocketClient, type SocketControllerOptions } from './base.js';

export class WebSocketController extends SocketController {
	constructor(options: SocketControllerOptions) {
		super(options);

		this.handlers.set('items', (client, message, context) =>
			handleItems(message, context, (frame) => this.send(client, frame))
		);

		this.handlers.set('subscribe', (client, message, context) =>
			handleSubscription(client, message, context, (frame) => this.send(client, frame), this.subscriptions)
		);

		this.handlers.set('unsubscribe', (client, message, context) =>
			handleSubscription(client, message, context, (frame) => this.send(client, frame), this.subscriptions)
		);
	}

	protected override buildOnExpiry(client: SocketClient): () => void {
		return () => {
			this.send(client, this.errorFrame('TOKEN_EXPIRED', undefined, 'auth'));
		};
	}
}
