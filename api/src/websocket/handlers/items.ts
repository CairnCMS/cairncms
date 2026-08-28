import { ForbiddenException } from '../../exceptions/index.js';
import { MetaService } from '../../services/index.js';
import { sanitizeQuery } from '../../utils/sanitize-query.js';
import { validateQuery } from '../../utils/validate-query.js';
import type { CommandContext } from '../controllers/base.js';
import { toWebSocketException, WebSocketException } from '../exceptions.js';
import { WebSocketItemsMessage, type WebSocketMessage } from '../messages.js';
import { resolveTargetService } from '../target.js';
import { fmtMessage } from '../utils/message.js';

type GuardedSend = (frame: string) => { accepted: boolean };

async function readBackOrForbidden<T>(read: () => Promise<T>): Promise<T | undefined> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof ForbiddenException) return undefined;
		throw error;
	}
}

export async function handleItems(
	message: WebSocketMessage,
	context: CommandContext,
	send: GuardedSend
): Promise<void> {
	const uid = message.uid;

	try {
		const parsed = WebSocketItemsMessage.parse(message);
		const { schema, accountability } = context;

		const service = resolveTargetService(parsed.collection, { schema, accountability });
		if (service === null) throw new WebSocketException('items', 'FORBIDDEN', uid);

		const isSingleton = schema.collections[parsed.collection]?.singleton === true;
		const metaService = new MetaService({ schema, accountability });

		let data: unknown;
		let meta: Record<string, unknown> | undefined;

		if (parsed.action === 'create') {
			if (isSingleton) throw new WebSocketException('items', 'INVALID_PAYLOAD', uid);

			const query = validateQuery(sanitizeQuery(parsed.query ?? {}, accountability));

			if (Array.isArray(parsed.data)) {
				const keys = await service.createMany(parsed.data);
				data = await readBackOrForbidden(() => service.readMany(keys, query));
			} else {
				const key = await service.createOne(parsed.data);
				data = await readBackOrForbidden(() => service.readOne(key, query));
			}
		} else if (parsed.action === 'read') {
			if (parsed.id !== undefined && parsed.ids !== undefined) {
				throw new WebSocketException('items', 'INVALID_PAYLOAD', uid);
			}

			const query = validateQuery(sanitizeQuery(parsed.query ?? {}, accountability));

			if (parsed.id !== undefined) {
				data = await service.readOne(parsed.id, query);
			} else if (parsed.ids !== undefined) {
				data = await service.readMany(parsed.ids, query);
			} else if (isSingleton) {
				data = await service.readSingleton(query);
			} else {
				data = await service.readByQuery(query);
			}

			meta = await metaService.getMetaForQuery(parsed.collection, query);
		} else if (parsed.action === 'update') {
			if (parsed.id !== undefined && parsed.ids !== undefined) {
				throw new WebSocketException('items', 'INVALID_PAYLOAD', uid);
			}

			const query = validateQuery(sanitizeQuery(parsed.query ?? {}, accountability));

			if (parsed.id !== undefined) {
				const key = await service.updateOne(parsed.id, parsed.data);
				data = await readBackOrForbidden(() => service.readOne(key, query));
			} else if (parsed.ids !== undefined) {
				const keys = await service.updateMany(parsed.ids, parsed.data);

				const back = await readBackOrForbidden(async () => ({
					data: await service.readMany(keys, query),
					meta: await metaService.getMetaForQuery(parsed.collection, query),
				}));

				data = back?.data;
				meta = back?.meta;
			} else if (isSingleton) {
				await service.upsertSingleton(parsed.data);
				data = await service.readSingleton(query);
			} else if (parsed.query !== undefined) {
				const keys = await service.updateByQuery(query, parsed.data);

				const back = await readBackOrForbidden(async () => ({
					data: await service.readMany(keys, query),
					meta: await metaService.getMetaForQuery(parsed.collection, query),
				}));

				data = back?.data;
				meta = back?.meta;
			} else {
				throw new WebSocketException('items', 'INVALID_PAYLOAD', uid);
			}
		} else {
			if (parsed.id !== undefined && parsed.ids !== undefined) {
				throw new WebSocketException('items', 'INVALID_PAYLOAD', uid);
			}

			if (parsed.id !== undefined) {
				await service.deleteOne(parsed.id);
				data = parsed.id;
			} else if (parsed.ids !== undefined) {
				await service.deleteMany(parsed.ids);
				data = parsed.ids;
			} else if (parsed.query !== undefined) {
				const query = validateQuery(sanitizeQuery(parsed.query, accountability));
				data = await service.deleteByQuery(query);
			} else {
				throw new WebSocketException('items', 'INVALID_PAYLOAD', uid);
			}
		}

		send(fmtMessage('items', { data, ...(meta ? { meta } : {}) }, uid));
	} catch (error) {
		throw toWebSocketException(error, 'items', uid);
	}
}
