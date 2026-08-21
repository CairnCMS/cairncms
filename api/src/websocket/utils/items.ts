import type { SchemaOverview } from '@cairncms/types';
import { MetaService } from '../../services/index.js';
import type { ItemsService } from '../../services/index.js';
import type { RequestAccountability } from '../../utils/get-anonymous-accountability.js';
import type { Subscription } from '../subscriptions.js';

export async function getInitialPayload(
	service: ItemsService,
	subscription: Subscription,
	accountability: RequestAccountability,
	schema: SchemaOverview
): Promise<Record<string, unknown>> {
	const query = subscription.query;
	const result: Record<string, unknown> = { event: 'init' };

	result['data'] =
		subscription.item !== undefined
			? await service.readOne(subscription.item, query)
			: await service.readByQuery(query);

	if ('meta' in query) {
		const metaService = new MetaService({ schema, accountability });
		result['meta'] = await metaService.getMetaForQuery(subscription.collection, query);
	}

	return result;
}
