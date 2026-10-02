import { describe, expect, it } from 'vitest';
import { AdminMutationUnverifiedTransactionException } from './admin-mutation-unverified-transaction.js';
import { ConcurrencyConflictException } from './concurrency-conflict.js';
import { ConfigStateChangedException } from './config-state-changed.js';

const DRIVER_LEAK = /40001|40P01|1213|1205|deadlock|serialize|SQLITE_BUSY|ER_LOCK/i;

describe('continuity exceptions', () => {
	it('ConcurrencyConflictException is a 409 with a stable code and message and no driver detail', () => {
		const err = new ConcurrencyConflictException();
		expect(err.status).toBe(409);
		expect(err.code).toBe('CONCURRENCY_CONFLICT');

		expect(err.message).toBe(
			'The record was modified concurrently and the change was not applied. Reread the current state and retry.'
		);

		expect(err.message).not.toMatch(DRIVER_LEAK);
	});

	it('AdminMutationUnverifiedTransactionException is a 500 with a stable code and message and no driver detail', () => {
		const err = new AdminMutationUnverifiedTransactionException();
		expect(err.status).toBe(500);
		expect(err.code).toBe('ADMIN_MUTATION_UNVERIFIED_TRANSACTION');

		expect(err.message).toBe(
			'An administrator-affecting role change was refused because it ran inside a transaction whose isolation could not be verified.'
		);

		expect(err.message).not.toMatch(DRIVER_LEAK);
	});

	it('ConfigStateChangedException is a 409 with a stable code and message and no driver detail', () => {
		const err = new ConfigStateChangedException();
		expect(err.status).toBe(409);
		expect(err.code).toBe('CONFIG_STATE_CHANGED');

		expect(err.message).toBe(
			'The apply conflicted with a concurrent change and was rolled back. Recompute the plan and re-apply.'
		);

		expect(err.message).not.toMatch(DRIVER_LEAK);
	});
});
