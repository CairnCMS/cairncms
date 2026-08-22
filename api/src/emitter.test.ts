import type { EventContext } from '@cairncms/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from './emitter.js';
import logger from './logger.js';

vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const context = { database: {}, schema: null, accountability: null } as unknown as EventContext;

function deferred() {
	let resolve!: () => void;

	const promise = new Promise<void>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function loggedText(): string {
	return vi
		.mocked(logger.warn)
		.mock.calls.map((call) => String(call[0]))
		.join('\n');
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('Emitter.emitActionAndWait', () => {
	it('resolves only after a slow listener finishes when an earlier listener throws synchronously', async () => {
		const emitter = new Emitter();
		const gate = deferred();
		const order: string[] = [];

		emitter.onAction('roles.create', () => {
			throw new Error('sync boom');
		});

		emitter.onAction('roles.create', async () => {
			await gate.promise;
			order.push('slow-done');
		});

		const pending = emitter.emitActionAndWait('roles.create', {}, context).then(() => order.push('resolved'));
		gate.resolve();
		await pending;

		expect(order).toEqual(['slow-done', 'resolved']);
	});

	it('resolves only after a slow listener finishes when another rejects asynchronously', async () => {
		const emitter = new Emitter();
		const gate = deferred();
		const order: string[] = [];

		emitter.onAction('roles.create', async () => {
			throw new Error('async boom');
		});

		emitter.onAction('roles.create', async () => {
			await gate.promise;
			order.push('slow-done');
		});

		const pending = emitter.emitActionAndWait('roles.create', {}, context).then(() => order.push('resolved'));
		gate.resolve();
		await pending;

		expect(order).toEqual(['slow-done', 'resolved']);
	});

	it('invokes a wildcard-registered listener', async () => {
		const emitter = new Emitter();
		const fired: string[] = [];

		emitter.onAction('roles.*', (meta) => {
			fired.push(meta['event']);
		});

		await emitter.emitActionAndWait('roles.create', {}, context);

		expect(fired).toEqual(['roles.create']);
	});

	it('dispatches every event name in an array', async () => {
		const emitter = new Emitter();
		const fired: string[] = [];

		emitter.onAction('roles.create', (meta) => {
			fired.push(meta['event']);
		});

		emitter.onAction('permissions.create', (meta) => {
			fired.push(meta['event']);
		});

		await emitter.emitActionAndWait(['roles.create', 'permissions.create'], {}, context);

		expect(fired).toEqual(['roles.create', 'permissions.create']);
	});

	it('starts a later event name without waiting on an earlier unresolved listener', async () => {
		const emitter = new Emitter();
		const gate = deferred();
		const fired: string[] = [];

		emitter.onAction('items.create', async () => {
			await gate.promise;
		});

		emitter.onAction('articles.items.create', () => {
			fired.push('second');
		});

		const pending = emitter.emitActionAndWait(['items.create', 'articles.items.create'], {}, context);
		expect(fired).toEqual(['second']);

		gate.resolve();
		await pending;
	});

	it('logs the event name but never the raw error when a listener throws', async () => {
		const emitter = new Emitter();

		emitter.onAction('roles.create', () => {
			throw new Error('secret token abc123');
		});

		await emitter.emitActionAndWait('roles.create', {}, context);

		expect(logger.warn).toHaveBeenCalled();
		expect(loggedText()).toContain('roles.create');
		expect(loggedText()).not.toContain('abc123');
	});

	it('logs a rejection before an unresolved listener is released', async () => {
		const emitter = new Emitter();
		const gate = deferred();

		emitter.onAction('roles.create', async () => {
			throw new Error('boom');
		});

		emitter.onAction('roles.create', async () => {
			await gate.promise;
		});

		const pending = emitter.emitActionAndWait('roles.create', {}, context);
		await tick();

		expect(logger.warn).toHaveBeenCalled();

		gate.resolve();
		await pending;
	});

	it('invokes each listener with the emitter as receiver and the outer event, even after a nested emit', async () => {
		const emitter = new Emitter();
		let receiverHasEmit = false;
		let sawOuterEvent = false;

		emitter.onAction('permissions.create', () => {
			// a nested listener so the nested emit below actually changes the emitter's current event
		});

		emitter.onAction('roles.create', () => {
			emitter.emitAction('permissions.create', {}, context);
		});

		emitter.onAction('roles.create', function (this: { emit?: unknown; event?: unknown }) {
			receiverHasEmit = typeof this.emit === 'function';
			sawOuterEvent = this.event === 'roles.create';
		});

		await emitter.emitActionAndWait('roles.create', {}, context);

		expect(receiverHasEmit).toBe(true);
		expect(sawOuterEvent).toBe(true);
	});

	it('awaits a plain thenable without treating it as a failure', async () => {
		const emitter = new Emitter();
		let resolved = false;

		emitter.onAction('roles.create', (): any => ({
			then(onFulfilled: () => void) {
				resolved = true;
				onFulfilled();
			},
		}));

		await emitter.emitActionAndWait('roles.create', {}, context);

		expect(resolved).toBe(true);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe('Emitter.emitAction', () => {
	it('does not let a synchronous listener throw escape into the caller', () => {
		const emitter = new Emitter();

		emitter.onAction('roles.create', () => {
			throw new Error('sync boom');
		});

		expect(() => emitter.emitAction('roles.create', {}, context)).not.toThrow();
	});

	it('does not orphan an async rejection when a later listener throws synchronously', async () => {
		const emitter = new Emitter();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);

		try {
			emitter.onAction('roles.create', async () => {
				throw new Error('async first');
			});

			emitter.onAction('roles.create', () => {
				throw new Error('sync second');
			});

			emitter.emitAction('roles.create', {}, context);
			await tick();

			expect(unhandled).toEqual([]);
			expect(logger.warn).toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('schedules a later event name after an earlier one throws synchronously', async () => {
		const emitter = new Emitter();
		const fired: string[] = [];

		emitter.onAction('roles.create', () => {
			throw new Error('sync boom');
		});

		emitter.onAction('permissions.create', (meta) => {
			fired.push(meta['event']);
		});

		emitter.emitAction(['roles.create', 'permissions.create'], {}, context);
		await tick();

		expect(fired).toEqual(['permissions.create']);
	});

	it('logs the event name but never the raw error on an asynchronous rejection', async () => {
		const emitter = new Emitter();

		emitter.onAction('roles.create', async () => {
			throw new Error('secret token xyz789');
		});

		emitter.emitAction('roles.create', {}, context);
		await tick();

		expect(logger.warn).toHaveBeenCalled();
		expect(loggedText()).not.toContain('xyz789');
	});
});
