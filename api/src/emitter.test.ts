import type { Knex } from 'knex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from './emitter.js';
import logger from './logger.js';

const CONTEXT = { database: {} as Knex, schema: null, accountability: null };

function deferred() {
	let resolve!: () => void;

	const promise = new Promise<void>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('emitActionBounded', () => {
	it('runs every matched listener including wildcards and waits for all to settle', async () => {
		const emitter = new Emitter();
		const gate = deferred();
		let wildcardRan = false;

		emitter.onAction('websocket.message', () => {
			throw new Error('synchronous boom');
		});

		emitter.onAction('websocket.*', async () => {
			await gate.promise;
			wildcardRan = true;
		});

		let settled = false;

		const done = emitter.emitActionBounded('websocket.message', {}, CONTEXT).then(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(settled).toBe(false);
		expect(wildcardRan).toBe(false);

		gate.resolve();
		await done;
		expect(wildcardRan).toBe(true);
		expect(settled).toBe(true);
	});

	it('contains a rejecting listener, resolving and logging one fixed diagnostic without the raw error', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
		const emitter = new Emitter();

		emitter.onAction('websocket.message', async () => {
			throw new Error('secret-boom');
		});

		await expect(emitter.emitActionBounded('websocket.message', {}, CONTEXT)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith('An action listener threw and was contained');
		expect(warn.mock.calls.flat().map(String).join(' ')).not.toContain('secret-boom');
	});

	it('invokes listeners synchronously so a lifecycle listener runs before the caller continues', () => {
		const emitter = new Emitter();
		let ran = false;

		emitter.onAction('websocket.close', () => {
			ran = true;
		});

		void emitter.emitActionBounded('websocket.close', {}, CONTEXT);
		expect(ran).toBe(true);
	});
});
