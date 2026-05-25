import { describe, expect, test, vi } from 'vitest';
import { getFolderFilter } from './get-folder-filter';

const TYPE_FILTER = { type: { _nnull: true } };

describe('getFolderFilter', () => {
	test('with no folder and no special, scopes to root files', () => {
		expect(getFolderFilter()).toEqual({
			_and: [TYPE_FILTER, { folder: { _null: true } }],
		});
	});

	test('with a folder and no special, scopes to that folder', () => {
		expect(getFolderFilter('folder-id-123')).toEqual({
			_and: [TYPE_FILTER, { folder: { _eq: 'folder-id-123' } }],
		});
	});

	test('with special="all", returns only the type filter', () => {
		expect(getFolderFilter(undefined, 'all')).toEqual({
			_and: [TYPE_FILTER],
		});
	});

	test('with special="mine" and a current user, adds an uploaded_by filter', () => {
		expect(getFolderFilter(undefined, 'mine', 'user-id-456')).toEqual({
			_and: [TYPE_FILTER, { uploaded_by: { _eq: 'user-id-456' } }],
		});
	});

	test('with special="mine" but no current user, returns only the type filter', () => {
		expect(getFolderFilter(undefined, 'mine')).toEqual({
			_and: [TYPE_FILTER],
		});
	});

	test('with special="recent", adds an uploaded_on filter for the last 5 days', () => {
		vi.useFakeTimers();

		try {
			vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));

			expect(getFolderFilter(undefined, 'recent')).toEqual({
				_and: [TYPE_FILTER, { uploaded_on: { _gt: '2026-05-20T12:00:00.000Z' } }],
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
