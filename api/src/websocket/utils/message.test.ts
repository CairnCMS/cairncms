import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { fmtMessage, getMessageType, safeSend } from './message.js';

const LIMITS = { frameCap: 1024, queueByteBound: 4096 };

interface FakeClient {
	OPEN: number;
	readyState: number;
	bufferedAmount: number;
	sent: string[];
	sendError?: Error;
	send: (frame: string, cb: (error?: Error) => void) => void;
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
	const client: FakeClient = {
		OPEN: 1,
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		send(frame, cb) {
			this.sent.push(frame);
			cb(this.sendError);
		},
		...overrides,
	};

	return client;
}

function send(client: FakeClient, frame: string) {
	const closes: (number | undefined)[] = [];
	const result = safeSend(client as unknown as WebSocket, frame, LIMITS, (code) => closes.push(code));
	return { result, closes };
}

describe('getMessageType', () => {
	it('returns the type for an object and empty string otherwise', () => {
		expect(getMessageType({ type: 'auth' })).toBe('auth');
		expect(getMessageType(null)).toBe('');
		expect(getMessageType([1, 2])).toBe('');
		expect(getMessageType('nope')).toBe('');
	});
});

describe('fmtMessage', () => {
	it('builds a frame with type, data, and an optional uid', () => {
		expect(JSON.parse(fmtMessage('auth', { status: 'ok' }, 3))).toEqual({ type: 'auth', status: 'ok', uid: 3 });
		expect(JSON.parse(fmtMessage('auth', { status: 'ok' })).uid).toBeUndefined();
	});
});

describe('safeSend', () => {
	it('sends a frame within the limits and reports accepted', () => {
		const client = fakeClient();
		const { result, closes } = send(client, '{"ok":true}');
		expect(result).toEqual({ accepted: true });
		expect(client.sent).toHaveLength(1);
		expect(closes).toEqual([]);
	});

	it('refuses and neither sends nor closes when the socket is not open', () => {
		const client = fakeClient({ readyState: 3 });
		const { result, closes } = send(client, '{}');
		expect(result).toEqual({ accepted: false });
		expect(client.sent).toHaveLength(0);
		expect(closes).toEqual([]);
	});

	it('accepts a frame at the frame cap and closes 1009 one byte over', () => {
		const atCap = fakeClient();
		expect(send(atCap, 'x'.repeat(LIMITS.frameCap)).result).toEqual({ accepted: true });

		const overCap = fakeClient();
		const { result, closes } = send(overCap, 'x'.repeat(LIMITS.frameCap + 1));
		expect(result).toEqual({ accepted: false });
		expect(overCap.sent).toHaveLength(0);
		expect(closes).toEqual([1009]);
	});

	it('accepts a frame filling the queue bound and closes 1013 one byte over', () => {
		const atBound = fakeClient({ bufferedAmount: LIMITS.queueByteBound - 10 });
		expect(send(atBound, 'x'.repeat(10)).result).toEqual({ accepted: true });

		const overBound = fakeClient({ bufferedAmount: LIMITS.queueByteBound - 9 });
		const { result, closes } = send(overBound, 'x'.repeat(10));
		expect(result).toEqual({ accepted: false });
		expect(overBound.sent).toHaveLength(0);
		expect(closes).toEqual([1013]);
	});

	it('routes an asynchronous write error through the close callback', () => {
		const client = fakeClient({ sendError: new Error('write failed') });
		const { result, closes } = send(client, '{}');
		expect(result).toEqual({ accepted: true });
		expect(closes).toEqual([undefined]);
	});
});
