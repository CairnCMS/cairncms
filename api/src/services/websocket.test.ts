import { beforeEach, describe, expect, it, vi } from 'vitest';

const getActiveRealtime = vi.fn();
const onAction = vi.fn();
const offAction = vi.fn();

vi.mock('../websocket/controllers/active.js', () => ({ getActiveRealtime }));
vi.mock('../emitter.js', () => ({ default: { onAction, offAction } }));

const { WebSocketService } = await import('./websocket.js');
const { ServiceUnavailableException } = await import('../exceptions/index.js');

function restAccess() {
	return { broadcast: vi.fn(), clients: vi.fn(() => new Set([{ uid: 'a' }])) };
}

function accessWith(transports: Record<string, unknown>) {
	return { transport: (key: string) => transports[key] ?? null, info: vi.fn() };
}

beforeEach(() => {
	getActiveRealtime.mockReset();
	onAction.mockReset();
	offAction.mockReset();
});

describe('WebSocketService', () => {
	it('registers and removes a lifecycle listener for each event', () => {
		getActiveRealtime.mockReturnValue(accessWith({ rest: restAccess() }));
		const service = new WebSocketService();
		const handler = () => undefined;

		for (const event of ['connect', 'message', 'error', 'close'] as const) {
			service.on(event, handler);
			expect(onAction).toHaveBeenCalledWith(`websocket.${event}`, handler);
			service.off(event, handler);
			expect(offAction).toHaveBeenCalledWith(`websocket.${event}`, handler);
		}
	});

	it('broadcasts a string verbatim and an object as JSON, and returns the client snapshot', () => {
		const rest = restAccess();
		getActiveRealtime.mockReturnValue(accessWith({ rest }));
		const service = new WebSocketService();

		service.broadcast('raw', { user: 'u1' });
		expect(rest.broadcast).toHaveBeenCalledWith('raw', { user: 'u1' });

		service.broadcast({ type: 'announce', body: 'x' });
		expect(rest.broadcast).toHaveBeenCalledWith(JSON.stringify({ type: 'announce', body: 'x' }), undefined);

		expect(service.clients()).toBeInstanceOf(Set);
		expect(rest.clients).toHaveBeenCalledTimes(1);
	});

	it('constructs without realtime active and defers the live check to operations', () => {
		getActiveRealtime.mockReturnValue(null);

		const service = new WebSocketService();
		const handler = () => undefined;

		service.on('connect', handler);
		expect(onAction).toHaveBeenCalledWith('websocket.connect', handler);

		try {
			service.broadcast('x');
			expect.fail('expected broadcast to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(ServiceUnavailableException);
			expect((error as InstanceType<typeof ServiceUnavailableException>).extensions.service).toBe('websocket');
		}

		expect(() => service.clients()).toThrow(ServiceUnavailableException);
	});

	it('fails operations when only a non-REST transport is active', () => {
		getActiveRealtime.mockReturnValue(accessWith({ graphql: restAccess() }));

		const service = new WebSocketService();
		expect(() => service.broadcast('x')).toThrow(ServiceUnavailableException);
		expect(() => service.clients()).toThrow(ServiceUnavailableException);
	});

	it('fails closed on operations after activation stops, but off still works', () => {
		getActiveRealtime.mockReturnValue(accessWith({ rest: restAccess() }));
		const service = new WebSocketService();
		const handler = () => undefined;

		getActiveRealtime.mockReturnValue(null);

		expect(() => service.broadcast('x')).toThrow(ServiceUnavailableException);
		expect(() => service.clients()).toThrow(ServiceUnavailableException);

		service.off('connect', handler);
		expect(offAction).toHaveBeenCalledWith('websocket.connect', handler);
	});

	it('touches only the REST transport when other transports are present', () => {
		const rest = restAccess();
		const graphql = restAccess();
		getActiveRealtime.mockReturnValue(accessWith({ rest, graphql }));
		const service = new WebSocketService();

		service.broadcast('x');
		service.clients();

		expect(rest.broadcast).toHaveBeenCalledTimes(1);
		expect(rest.clients).toHaveBeenCalledTimes(1);
		expect(graphql.broadcast).not.toHaveBeenCalled();
		expect(graphql.clients).not.toHaveBeenCalled();
	});
});
