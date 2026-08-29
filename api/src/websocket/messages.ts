import type { Item, Query } from '@cairncms/types';
import { isPlainObject } from 'lodash-es';
import { z } from 'zod';

const zodStringOrNumber = z.union([z.string(), z.number()]);

export const WebSocketMessage = z
	.object({
		type: z.string(),
		uid: zodStringOrNumber.optional(),
	})
	.passthrough();

export type WebSocketMessage = z.infer<typeof WebSocketMessage>;

export const WebSocketResponse = z.discriminatedUnion('status', [
	WebSocketMessage.extend({
		status: z.literal('ok'),
	}),
	WebSocketMessage.extend({
		status: z.literal('error'),
		error: z
			.object({
				code: z.string(),
				message: z.string(),
			})
			.passthrough(),
	}),
]);

export type WebSocketResponse = z.infer<typeof WebSocketResponse>;

export const WebSocketAuthMessage = WebSocketMessage.extend({
	type: z.literal('auth'),
	access_token: z.string(),
});

export type WebSocketAuthMessage = z.infer<typeof WebSocketAuthMessage>;

export const ConnectionParams = z.object({ access_token: z.string().optional() });

export type ConnectionParams = z.infer<typeof ConnectionParams>;

const ZodItem = z.custom<Partial<Item>>((value) => isPlainObject(value));
const ZodQuery = z.custom<Query>((value) => isPlainObject(value));

const PartialItemsMessage = z.object({
	uid: zodStringOrNumber.optional(),
	type: z.literal('items'),
	collection: z.string(),
});

export const WebSocketItemsMessage = z.union([
	PartialItemsMessage.extend({
		action: z.literal('create'),
		data: z.union([z.array(ZodItem), ZodItem]),
		query: ZodQuery.optional(),
	}),
	PartialItemsMessage.extend({
		action: z.literal('read'),
		ids: z.array(zodStringOrNumber).optional(),
		id: zodStringOrNumber.optional(),
		query: ZodQuery.optional(),
	}),
	PartialItemsMessage.extend({
		action: z.literal('update'),
		data: ZodItem,
		ids: z.array(zodStringOrNumber).optional(),
		id: zodStringOrNumber.optional(),
		query: ZodQuery.optional(),
	}),
	PartialItemsMessage.extend({
		action: z.literal('delete'),
		ids: z.array(zodStringOrNumber).optional(),
		id: zodStringOrNumber.optional(),
		query: ZodQuery.optional(),
	}),
]);

export type WebSocketItemsMessage = z.infer<typeof WebSocketItemsMessage>;

export const WebSocketSubscribeMessage = z.discriminatedUnion('type', [
	WebSocketMessage.extend({
		type: z.literal('subscribe'),
		collection: z.string(),
		event: z.enum(['create', 'update', 'delete']).optional(),
		item: zodStringOrNumber.optional(),
		query: ZodQuery.optional(),
	}),
	WebSocketMessage.extend({
		type: z.literal('unsubscribe'),
	}),
]);

export type WebSocketSubscribeMessage = z.infer<typeof WebSocketSubscribeMessage>;

export const WebSocketEvent = z.discriminatedUnion('action', [
	z.object({ action: z.literal('create'), collection: z.string(), key: zodStringOrNumber }),
	z.object({ action: z.literal('update'), collection: z.string(), keys: z.array(zodStringOrNumber) }),
	z.object({ action: z.literal('delete'), collection: z.string(), keys: z.array(zodStringOrNumber) }),
]);

export type WebSocketEvent = z.infer<typeof WebSocketEvent>;
