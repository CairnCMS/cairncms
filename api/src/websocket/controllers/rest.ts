import { SocketController, type SocketClient } from './base.js';

export class WebSocketController extends SocketController {
	protected override buildOnExpiry(client: SocketClient): () => void {
		return () => {
			this.send(client, this.errorFrame('TOKEN_EXPIRED', undefined, 'auth'));
		};
	}
}
