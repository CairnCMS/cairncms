import type { WebSocket } from 'ws';

const CLOSE_MESSAGE_TOO_BIG = 1009;
const CLOSE_TRY_AGAIN_LATER = 1013;

export interface OutboundLimits {
	frameCap: number;
	queueByteBound: number;
}

export function getMessageType(message: unknown): string {
	if (typeof message !== 'object' || message === null || Array.isArray(message)) return '';
	return String((message as Record<string, unknown>)['type']);
}

export function fmtMessage(type: string, data: Record<string, unknown> = {}, uid?: string | number): string {
	const message: Record<string, unknown> = { type, ...data };
	if (uid !== undefined) message['uid'] = uid;
	return JSON.stringify(message);
}

export function safeSend(
	client: WebSocket,
	frame: string,
	limits: OutboundLimits,
	onClose: (code?: number) => void
): { accepted: boolean } {
	if (client.readyState !== client.OPEN) return { accepted: false };

	const bytes = Buffer.byteLength(frame);

	if (bytes > limits.frameCap) {
		onClose(CLOSE_MESSAGE_TOO_BIG);
		return { accepted: false };
	}

	if (client.bufferedAmount + bytes > limits.queueByteBound) {
		onClose(CLOSE_TRY_AGAIN_LATER);
		return { accepted: false };
	}

	client.send(frame, (error?: Error) => {
		if (error) onClose();
	});

	return { accepted: true };
}
