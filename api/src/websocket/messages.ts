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
