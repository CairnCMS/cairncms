import type { Query } from '@cairncms/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketClient } from './controllers/base.js';
import type { Reservation, Subscription } from './subscriptions.js';

vi.mock('./config.js', () => ({ SUBSCRIPTIONS_PER_CONNECTION: 3, SUBSCRIPTIONS_PER_PROCESS: 5 }));

const { SubscriptionRegistry, canonicalItemKey } = await import('./subscriptions.js');

function client(): SocketClient {
	return {} as SocketClient;
}

function sub(c: SocketClient, collection: string, extra: Partial<Subscription> = {}): Subscription {
	return { client: c, collection, query: {} as Query, ...extra };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

let registry: InstanceType<typeof SubscriptionRegistry>;

beforeEach(() => {
	registry = new SubscriptionRegistry();
});

function reserve(subscription: Subscription): Reservation {
	const result = registry.reserve(subscription);
	if (!result.ok) throw new Error(`reserve refused: ${result.reason}`);
	return result.reservation;
}

describe('canonicalItemKey', () => {
	it('maps equivalent numeric and string keys to the same string, honoring 0', () => {
		expect(canonicalItemKey(1)).toBe('1');
		expect(canonicalItemKey('1')).toBe('1');
		expect(canonicalItemKey(0)).toBe('0');
	});
});

describe('SubscriptionRegistry bounds', () => {
	it('reserves up to the per-connection bound and refuses the next with a limit reason', () => {
		const c = client();
		expect(registry.reserve(sub(c, 'articles')).ok).toBe(true);
		expect(registry.reserve(sub(c, 'articles')).ok).toBe(true);
		expect(registry.reserve(sub(c, 'articles')).ok).toBe(true);
		expect(registry.reserve(sub(c, 'articles'))).toEqual({ ok: false, reason: 'limit' });
	});

	it('refuses at the per-process bound across connections and stores nothing on refusal', () => {
		const a = client();
		const b = client();
		for (let i = 0; i < 3; i++) reserve(sub(a, 'articles'));
		reserve(sub(b, 'articles'));
		const last = reserve(sub(b, 'articles'));

		expect(registry.reserve(sub(b, 'articles'))).toEqual({ ok: false, reason: 'limit' });

		last.remove();
		expect(registry.reserve(sub(b, 'articles')).ok).toBe(true);
	});
});

describe('SubscriptionRegistry availability', () => {
	it('refuses with an unavailable reason while overloaded and recovers on exit', () => {
		registry.enterOverload();
		expect(registry.reserve(sub(client(), 'articles'))).toEqual({ ok: false, reason: 'unavailable' });

		registry.exitOverload();
		expect(registry.reserve(sub(client(), 'articles')).ok).toBe(true);
	});

	it('refuses terminally after markUnavailable, which exitOverload does not clear', () => {
		registry.markUnavailable();
		registry.exitOverload();
		expect(registry.reserve(sub(client(), 'articles'))).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('lets availability win over capacity when both would refuse', () => {
		const c = client();
		for (let i = 0; i < 3; i++) reserve(sub(c, 'articles'));
		registry.enterOverload();

		expect(registry.reserve(sub(c, 'articles'))).toEqual({ ok: false, reason: 'unavailable' });
	});
});

describe('SubscriptionRegistry state machine', () => {
	it('keeps a reservation out of the active snapshot until activate', () => {
		const reservation = reserve(sub(client(), 'articles'));
		expect(registry.getActiveByCollection('articles', 999)).toHaveLength(0);
		reservation.activate();
		expect(registry.getActiveByCollection('articles', 999)).toEqual([reservation]);
	});

	it('resolves settled on activate and on remove', async () => {
		const activated = reserve(sub(client(), 'articles'));
		activated.activate();
		await expect(activated.settled).resolves.toBeUndefined();

		const removed = reserve(sub(client(), 'articles'));
		removed.remove();
		await expect(removed.settled).resolves.toBeUndefined();
	});

	it('is a no-op to activate after remove', () => {
		const reservation = reserve(sub(client(), 'articles'));
		reservation.remove();
		reservation.activate();
		expect(reservation.isActive()).toBe(false);
		expect(registry.getActiveByCollection('articles', 999)).toHaveLength(0);
	});

	it('is a no-op to activate twice', () => {
		const reservation = reserve(sub(client(), 'articles'));
		reservation.activate();
		reservation.activate();
		expect(registry.getActiveByCollection('articles', 999)).toEqual([reservation]);
	});

	it('does not double-decrement capacity on a duplicate remove', () => {
		const c = client();
		const first = reserve(sub(c, 'articles'));
		reserve(sub(c, 'articles'));
		reserve(sub(c, 'articles'));

		first.remove();
		first.remove();

		expect(registry.reserve(sub(c, 'articles')).ok).toBe(true);
		expect(registry.reserve(sub(c, 'articles'))).toEqual({ ok: false, reason: 'limit' });
	});
});

describe('SubscriptionRegistry removal', () => {
	it('removeByUid removes exactly the matching reservation', () => {
		const c = client();
		reserve(sub(c, 'articles', { uid: '1' })).activate();
		const kept = reserve(sub(c, 'articles', { uid: '2' }));
		kept.activate();

		registry.removeByUid(c, '1');
		expect(registry.getActiveByCollection('articles', 999)).toEqual([kept]);
	});

	it('removeAllForClient releases every reservation, initializing or active', () => {
		const c = client();
		reserve(sub(c, 'articles')).activate();
		reserve(sub(c, 'posts'));

		registry.removeAllForClient(c);
		expect(registry.getActiveByCollection('articles', 999)).toHaveLength(0);
		expect(registry.getSubscribedOwners()).toHaveLength(0);
	});
});

describe('SubscriptionRegistry snapshots', () => {
	it('getActiveByCollection returns a stable snapshot', () => {
		const c = client();
		reserve(sub(c, 'articles')).activate();
		const snapshot = registry.getActiveByCollection('articles', 999);
		reserve(sub(c, 'articles')).activate();

		expect(snapshot).toHaveLength(1);
		(snapshot as Reservation[]).pop();
		expect(registry.getActiveByCollection('articles', 999)).toHaveLength(2);
	});

	it('getSubscribedOwners deduplicates and includes initializing-only owners', () => {
		const a = client();
		const b = client();
		reserve(sub(a, 'articles')).activate();
		reserve(sub(a, 'posts')).activate();
		reserve(sub(b, 'articles'));

		const owners = registry.getSubscribedOwners();
		expect(owners).toHaveLength(2);
		expect(owners).toContain(a);
		expect(owners).toContain(b);
	});
});

describe('SubscriptionRegistry dispatch context', () => {
	it('resolves the barrier when a captured initializing reservation activates', async () => {
		const reservation = reserve(sub(client(), 'articles'));
		const context = registry.captureDispatchContext('articles');
		const wait = context.barrier.wait(new AbortController().signal);

		let settled = false;

		void wait.then(() => {
			settled = true;
		});

		await flush();
		expect(settled).toBe(false);

		reservation.activate();
		await expect(wait).resolves.toBeUndefined();
	});

	it('resolves the barrier when a captured initializing reservation is removed', async () => {
		const reservation = reserve(sub(client(), 'articles'));
		const context = registry.captureDispatchContext('articles');
		const wait = context.barrier.wait(new AbortController().signal);
		reservation.remove();
		await expect(wait).resolves.toBeUndefined();
	});

	it('is already resolved when no initialization is in flight', async () => {
		const context = registry.captureDispatchContext('articles');
		await expect(context.barrier.wait(new AbortController().signal)).resolves.toBeUndefined();
	});

	it('is not delayed by an initialization begun after the capture', async () => {
		const captured = reserve(sub(client(), 'articles'));
		const context = registry.captureDispatchContext('articles');
		const wait = context.barrier.wait(new AbortController().signal);
		const later = reserve(sub(client(), 'articles'));

		captured.activate();
		await expect(wait).resolves.toBeUndefined();
		expect(later.isActive()).toBe(false);
	});

	it('resolves immediately when the wait signal is already aborted', async () => {
		reserve(sub(client(), 'articles'));
		const context = registry.captureDispatchContext('articles');
		const controller = new AbortController();
		controller.abort();
		await expect(context.barrier.wait(controller.signal)).resolves.toBeUndefined();
	});

	it('resolves a canceled wait and leaves the reservation free to settle afterward', async () => {
		const reservation = reserve(sub(client(), 'articles'));
		const context = registry.captureDispatchContext('articles');
		const controller = new AbortController();
		const wait = context.barrier.wait(controller.signal);

		controller.abort();
		await expect(wait).resolves.toBeUndefined();

		reservation.activate();
		expect(reservation.isActive()).toBe(true);
	});

	it('scopes recipients by the generation cutoff', () => {
		const c = client();
		const active = reserve(sub(c, 'articles'));
		active.activate();
		const initializing = reserve(sub(c, 'articles'));

		const context = registry.captureDispatchContext('articles');

		initializing.activate();
		const later = reserve(sub(c, 'articles'));
		later.activate();

		const recipients = registry.getActiveByCollection('articles', context.generation);
		expect(recipients).toContain(active);
		expect(recipients).toContain(initializing);
		expect(recipients).not.toContain(later);
	});
});
