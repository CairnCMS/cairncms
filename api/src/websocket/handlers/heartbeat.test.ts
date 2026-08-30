import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { startHeartbeat } from './heartbeat.js';

const PERIOD = 100;

function fakeWs() {
	const ws = new EventEmitter() as unknown as WebSocket & EventEmitter;
	(ws as unknown as { ping: ReturnType<typeof vi.fn> }).ping = vi.fn();
	return ws;
}

function pingCalls(ws: WebSocket): number {
	return (ws as unknown as { ping: ReturnType<typeof vi.fn> }).ping.mock.calls.length;
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('startHeartbeat', () => {
	it('sends a ping each period, and a pong keeps it alive for the next tick', () => {
		const ws = fakeWs();
		startHeartbeat(ws, PERIOD, vi.fn());

		vi.advanceTimersByTime(PERIOD);
		expect(pingCalls(ws)).toBe(1);

		ws.emit('pong');
		vi.advanceTimersByTime(PERIOD);
		expect(pingCalls(ws)).toBe(2);
	});

	it('closes exactly two periods after the last pong', () => {
		const ws = fakeWs();
		const onDead = vi.fn();
		startHeartbeat(ws, PERIOD, onDead);

		vi.advanceTimersByTime(PERIOD);
		ws.emit('pong');

		vi.advanceTimersByTime(2 * PERIOD - 1);
		expect(onDead).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onDead).toHaveBeenCalledTimes(1);
	});

	it('closes after two periods when the peer never pongs, ignoring other activity', () => {
		const ws = fakeWs();
		const onDead = vi.fn();
		startHeartbeat(ws, PERIOD, onDead);

		ws.emit('message', Buffer.from('x'));
		vi.advanceTimersByTime(2 * PERIOD);

		expect(onDead).toHaveBeenCalledTimes(1);
	});

	it('does not resurrect after the deadline: a later pong arms no new timer', () => {
		const ws = fakeWs();
		const onDead = vi.fn();
		startHeartbeat(ws, PERIOD, onDead);

		vi.advanceTimersByTime(2 * PERIOD);
		expect(onDead).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);

		ws.emit('pong');
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(10 * PERIOD);
		expect(onDead).toHaveBeenCalledTimes(1);
	});

	it('teardown clears both timers and the pong listener, and is idempotent', () => {
		const ws = fakeWs();
		const onDead = vi.fn();
		const stop = startHeartbeat(ws, PERIOD, onDead);

		stop();
		expect(vi.getTimerCount()).toBe(0);
		expect(ws.listenerCount('pong')).toBe(0);

		vi.advanceTimersByTime(10 * PERIOD);
		expect(onDead).not.toHaveBeenCalled();
		expect(pingCalls(ws)).toBe(0);

		stop();
	});
});
