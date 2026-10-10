import { describe, expect, test, vi } from 'vitest';
import type { Snapshot } from '../types/snapshot.js';
import { validateSnapshot, validateSnapshotVersion } from './validate-snapshot.js';

vi.mock('./package.js', () => ({
	version: '1.0.0',
}));

vi.mock('../database/index.js', () => ({
	getDatabaseClient: () => 'sqlite',
}));

describe('should fail on invalid snapshot schema', () => {
	test('empty snapshot', () => {
		const snapshot = {} as Snapshot;

		expect(() => validateSnapshot(snapshot)).toThrowError('"version" is required');
	});

	test('invalid version', () => {
		const snapshot = { version: 0 } as Snapshot;

		expect(() => validateSnapshot(snapshot)).toThrowError('"version" must be one of [1, 2]');
	});

	test('version 2 requires release, not directus', () => {
		expect(validateSnapshot({ version: 2, release: '1.0.0', vendor: 'sqlite' } as any)).toBeUndefined();

		expect(() => validateSnapshot({ version: 2, directus: '1.0.0', vendor: 'sqlite' } as any)).toThrowError(
			'"directus" is not allowed'
		);

		expect(() =>
			validateSnapshot({ version: 1, directus: '1.0.0', release: '1.0.0', vendor: 'sqlite' } as any)
		).toThrowError('"release" is not allowed');
	});

	test('invalid schema', () => {
		const snapshot = { version: 1, directus: '1.0.0', collections: {} } as Snapshot;

		expect(() => validateSnapshot(snapshot)).toThrowError('"collections" must be an array');
	});
});

describe('should require force option on version / vendor mismatch', () => {
	test('release mismatch, version 1', () => {
		const snapshot = { version: 1, directus: '9.26.0' } as Snapshot;

		expect(() => validateSnapshot(snapshot)).toThrowError(
			"Provided snapshot's CairnCMS version 9.26.0 does not match the current instance's version 1.0.0"
		);
	});

	test('release mismatch, version 2', () => {
		expect(() => validateSnapshot({ version: 2, release: '9.26.0' } as any)).toThrowError(
			"Provided snapshot's CairnCMS version 9.26.0 does not match the current instance's version 1.0.0"
		);
	});

	test('db vendor mismatch', () => {
		const snapshot = { version: 1, directus: '1.0.0', vendor: 'postgres' } as Snapshot;

		expect(() => validateSnapshot(snapshot)).toThrowError(
			"Provided snapshot's vendor postgres does not match the current instance's vendor sqlite."
		);
	});
});

test('should allow bypass on version / vendor mismatch via force option ', () => {
	const snapshot = { version: 1, directus: '9.26.0', vendor: 'postgres' } as Snapshot;

	expect(validateSnapshot(snapshot, true)).toBeUndefined();
});

describe('validateSnapshotVersion', () => {
	test.each([1, 2])('accepts version %i', (version) => {
		expect(validateSnapshotVersion({ version })).toBeUndefined();
	});

	test('uses the same messages as the full validation', () => {
		expect(() => validateSnapshotVersion({})).toThrowError('"version" is required');
		expect(() => validateSnapshotVersion({ version: 3 })).toThrowError('"version" must be one of [1, 2]');
		expect(() => validateSnapshotVersion(null)).toThrowError('"version" is required');
	});

	test.each(['1', '2'])('refuses the quoted version %s', (version) => {
		expect(() => validateSnapshotVersion({ version })).toThrowError('"version" must be one of [1, 2]');

		expect(() => validateSnapshot({ version, directus: '1.0.0', vendor: 'sqlite' } as any)).toThrowError(
			'"version" must be one of [1, 2]'
		);
	});

	test('does not validate anything but the version', () => {
		expect(validateSnapshotVersion({ version: 1, collections: 'not an array' })).toBeUndefined();
	});
});
