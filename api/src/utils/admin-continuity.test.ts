import { describe, expect, it } from 'vitest';
import { leavesAtLeastOneAdmin } from './admin-continuity.js';

function sets<Id>(current: Id[], removing: Id[], adding: Id[]) {
	return {
		currentAdmins: new Set(current),
		removing: new Set(removing),
		adding: new Set(adding),
	};
}

describe('leavesAtLeastOneAdmin', () => {
	it('keeps an admin when another remains after a removal', () => {
		expect(leavesAtLeastOneAdmin(sets(['a', 'b'], ['a'], []))).toBe(true);
	});

	it('rejects removing the only admin', () => {
		expect(leavesAtLeastOneAdmin(sets(['a'], ['a'], []))).toBe(false);
	});

	it('allows removing the only admin when one is added in the same step', () => {
		expect(leavesAtLeastOneAdmin(sets(['a'], ['a'], ['b']))).toBe(true);
	});

	it('rejects an empty administrator set', () => {
		expect(leavesAtLeastOneAdmin(sets([], [], []))).toBe(false);
	});

	it('rejects removing every current admin', () => {
		expect(leavesAtLeastOneAdmin(sets(['a', 'b'], ['a', 'b'], []))).toBe(false);
	});

	it('keeps admins that are not being removed', () => {
		expect(leavesAtLeastOneAdmin(sets(['a'], [], []))).toBe(true);
	});

	it('treats an addition as sufficient even when it also appears in removing', () => {
		expect(leavesAtLeastOneAdmin(sets(['a'], ['a'], ['a']))).toBe(true);
	});

	it('is generic over the identity type', () => {
		expect(leavesAtLeastOneAdmin(sets([1, 2], [2], []))).toBe(true);
		expect(leavesAtLeastOneAdmin(sets([1], [1], []))).toBe(false);
	});
});
