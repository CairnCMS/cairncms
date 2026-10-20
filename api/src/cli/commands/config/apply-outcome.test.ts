import { BaseException } from '@cairncms/exceptions';
import { describe, expect, it } from 'vitest';
import type { SchemaPersistedState } from '../../../types/index.js';
import { failureDetail, failureStatus } from './apply.js';

class Coded extends BaseException {
	constructor(code: string, extensions: Record<string, unknown> = {}) {
		super('message', 500, code, extensions);
	}
}

const persisted: SchemaPersistedState = { collections: [], fields: [], relations: [] };

describe('failureStatus', () => {
	it('reports a post-commit maintenance failure on either engine as committed', () => {
		expect(failureStatus(new Coded('SCHEMA_POST_COMMIT_FAILED'))).toBe('committed');
		expect(failureStatus(new Coded('CONFIG_POST_COMMIT_FAILED'))).toBe('committed');
	});

	it('reports a schema apply failure by its persisted state', () => {
		expect(failureStatus(new Coded('SCHEMA_APPLY_FAILED', { persisted }))).toBe('failed');
		expect(failureStatus(new Coded('SCHEMA_APPLY_FAILED', { persisted: 'unknown' }))).toBe('unknown');
	});

	it('reports a rolled-back transaction as rolled_back on either engine', () => {
		expect(failureStatus(new Coded('CONFIG_APPLY_FAILED'))).toBe('rolled_back');
		expect(failureStatus(new Coded('SCHEMA_STATE_CHANGED'))).toBe('rolled_back');
		expect(failureStatus(new Coded('CONFIG_STATE_CHANGED'))).toBe('rolled_back');
	});

	it('reports an unrecognized or non-coded error as failed', () => {
		expect(failureStatus(new Coded('CONFIG_PROTECTED_RECORD'))).toBe('failed');
		expect(failureStatus(new Error('boom'))).toBe('failed');
	});

	it('reads the first error of a thrown array', () => {
		expect(failureStatus([new Coded('CONFIG_POST_COMMIT_FAILED')])).toBe('committed');
	});
});

describe('failureDetail', () => {
	it('keeps only the persisted state and foreign-key flag of a schema apply failure', () => {
		const detail = failureDetail(
			new Coded('SCHEMA_APPLY_FAILED', { persisted, foreignKeysRestored: false, cause: 'ignored', note: 'leak' })
		);

		expect(detail).toEqual({ persisted, foreignKeysRestored: false });
	});

	it('omits the foreign-key flag when enforcement was restored', () => {
		expect(failureDetail(new Coded('SCHEMA_APPLY_FAILED', { persisted: 'unknown' }))).toEqual({ persisted: 'unknown' });
	});

	it('projects the persisted state to its declared shape, dropping unknown keys and malformed entries', () => {
		const detail = failureDetail(
			new Coded('SCHEMA_APPLY_FAILED', {
				persisted: {
					collections: [
						{ collection: 'articles', operation: 'create', table: 'applied', metadata: 'applied', note: 'leak' },
						{ collection: 'bad', operation: 'wipe', table: 'applied', metadata: 'applied' },
					],
					fields: [
						{ collection: 'articles', field: 'title', operation: 'update', column: 'HACKED', metadata: 'applied' },
					],
					relations: 'not-an-array',
					note: 'leak',
				},
			})
		);

		expect(detail).toEqual({
			persisted: {
				collections: [{ collection: 'articles', operation: 'create', table: 'applied', metadata: 'applied' }],
				fields: [
					{ collection: 'articles', field: 'title', operation: 'update', column: 'unknown', metadata: 'applied' },
				],
				relations: [],
			},
		});
	});

	it('reports an unrecognized or non-object persisted value as unknown', () => {
		expect(failureDetail(new Coded('SCHEMA_APPLY_FAILED', { persisted: 42 }))).toEqual({ persisted: 'unknown' });
	});

	it('keeps only the maintenance phase of a post-commit failure on either engine', () => {
		expect(failureDetail(new Coded('SCHEMA_POST_COMMIT_FAILED', { committed: true, phase: 'cache' }))).toEqual({
			phase: 'cache',
		});

		expect(failureDetail(new Coded('CONFIG_POST_COMMIT_FAILED', { committed: true, phase: 'actions' }))).toEqual({
			phase: 'actions',
		});
	});

	it('drops a maintenance phase that is not a recognized value', () => {
		expect(failureDetail(new Coded('SCHEMA_POST_COMMIT_FAILED', { phase: { nested: 'leak' } }))).toBeUndefined();
		expect(failureDetail(new Coded('CONFIG_POST_COMMIT_FAILED', { phase: 'bogus' }))).toBeUndefined();
	});

	it('returns nothing for an error that carries no persisted or maintenance detail', () => {
		expect(failureDetail(new Coded('CONFIG_APPLY_FAILED', { note: 'leak' }))).toBeUndefined();
		expect(failureDetail(new Error('boom'))).toBeUndefined();
	});
});
