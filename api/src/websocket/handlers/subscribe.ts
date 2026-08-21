import { sanitizeQuery } from '../../utils/sanitize-query.js';
import { validateQuery } from '../../utils/validate-query.js';
import type { CommandContext, SocketClient } from '../controllers/base.js';
import { toWebSocketException, WebSocketException } from '../exceptions.js';
import { WebSocketSubscribeMessage, type WebSocketMessage } from '../messages.js';
import { canonicalItemKey, type Subscription, type SubscriptionRegistry } from '../subscriptions.js';
import { resolveTargetService } from '../target.js';
import { getInitialPayload } from '../utils/items.js';
import { fmtMessage } from '../utils/message.js';

type GuardedSend = (frame: string) => { accepted: boolean };

export async function handleSubscription(
	client: SocketClient,
	message: WebSocketMessage,
	context: CommandContext,
	send: GuardedSend,
	registry: SubscriptionRegistry
): Promise<void> {
	const uid = message.uid !== undefined ? String(message.uid) : undefined;

	try {
		const parsed = WebSocketSubscribeMessage.parse(message);

		if (parsed.type === 'unsubscribe') {
			if (uid !== undefined) registry.removeByUid(client, uid);
			else registry.removeAllForClient(client);
			send(fmtMessage('subscription', { event: 'unsubscribe' }, uid));
			return;
		}

		const { schema, accountability } = context;

		const service = resolveTargetService(parsed.collection, { schema, accountability });
		if (service === null) throw new WebSocketException('subscribe', 'INVALID_COLLECTION', uid);

		const subscription: Subscription = {
			client,
			collection: parsed.collection,
			query: validateQuery(sanitizeQuery(parsed.query ?? {}, accountability)),
			...(uid !== undefined ? { uid } : {}),
			...(parsed.event !== undefined ? { event: parsed.event } : {}),
			...(parsed.item !== undefined ? { item: canonicalItemKey(parsed.item) } : {}),
		};

		if (uid !== undefined) registry.removeByUid(client, uid);

		const reservation = registry.reserve(subscription);
		if (reservation === null) throw new WebSocketException('subscribe', 'SUBSCRIPTION_LIMIT', uid);

		try {
			const data =
				parsed.event !== undefined
					? { event: 'init' }
					: await getInitialPayload(service, subscription, accountability, schema);

			if (client.stopping) {
				reservation.remove();
				return;
			}

			if (!send(fmtMessage('subscription', data, uid)).accepted) {
				reservation.remove();
				return;
			}

			reservation.activate();
		} catch (readError) {
			reservation.remove();
			throw readError;
		}
	} catch (error) {
		throw toWebSocketException(error, 'subscribe', uid);
	}
}
