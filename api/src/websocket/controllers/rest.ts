import { handleItems } from '../handlers/items.js';
import { SocketController, type SocketClient, type SocketControllerOptions } from './base.js';

export class WebSocketController extends SocketController {
	constructor(options: SocketControllerOptions) {
		super(options);

		this.handlers.set('items', (client, message, context) =>
			handleItems(message, context, (frame) => this.send(client, frame))
		);
	}

	protected override buildOnExpiry(client: SocketClient): () => void {
		return () => {
			this.send(client, this.errorFrame('TOKEN_EXPIRED', undefined, 'auth'));
		};
	}
}
