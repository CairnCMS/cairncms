import { describe, expect, it } from 'vitest';
import { isSerializationConflict } from './serialization-error.js';

describe('isSerializationConflict', () => {
	it('classifies a PostgreSQL serialization failure (40001)', () => {
		expect(isSerializationConflict({ code: '40001' })).toBe(true);
	});

	it('classifies a PostgreSQL deadlock (40P01)', () => {
		expect(isSerializationConflict({ code: '40P01' })).toBe(true);
	});

	it('classifies an InnoDB deadlock (errno 1213 / sqlState 40001)', () => {
		expect(isSerializationConflict({ code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001' })).toBe(true);
	});

	it('does not classify an InnoDB lock-wait timeout as a serialization conflict', () => {
		expect(isSerializationConflict({ code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205, sqlState: 'HY000' })).toBe(false);
	});

	it('does not classify SQLITE_BUSY as a serialization conflict', () => {
		expect(isSerializationConflict({ code: 'SQLITE_BUSY', errno: 5 })).toBe(false);
	});

	it('handles non-error inputs', () => {
		expect(isSerializationConflict(null)).toBe(false);
		expect(isSerializationConflict(undefined)).toBe(false);
		expect(isSerializationConflict('boom')).toBe(false);
		expect(isSerializationConflict({})).toBe(false);
	});
});
