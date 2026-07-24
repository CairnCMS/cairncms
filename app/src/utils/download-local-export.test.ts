import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExportParams, downloadLocalExport, getFilenameFromContentDisposition } from './download-local-export';

vi.mock('@/api', () => ({
	default: { get: vi.fn() },
}));

vi.mock('file-saver', () => ({
	saveAs: vi.fn(),
}));

import api from '@/api';
import { saveAs } from 'file-saver';

describe('buildExportParams', () => {
	it('never includes access_token', () => {
		const params = buildExportParams('csv', {});
		expect(params).not.toHaveProperty('access_token');
	});

	it('carries the export format', () => {
		const params = buildExportParams('csv', {});
		expect(params['export']).toBe('csv');
	});

	it('defaults limit to -1 when unset', () => {
		const params = buildExportParams('csv', {});
		expect(params['limit']).toBe(-1);
	});

	it('preserves an explicit limit', () => {
		const params = buildExportParams('csv', { limit: 50 });
		expect(params['limit']).toBe(50);
	});

	it('includes sort when set and non-empty', () => {
		const params = buildExportParams('csv', { sort: '-id' });
		expect(params['sort']).toBe('-id');
	});

	it('omits sort when empty string', () => {
		const params = buildExportParams('csv', { sort: '' });
		expect(params).not.toHaveProperty('sort');
	});

	it('includes fields when set', () => {
		const params = buildExportParams('csv', { fields: ['id', 'title'] });
		expect(params['fields']).toEqual(['id', 'title']);
	});

	it('includes search and filter when set', () => {
		const params = buildExportParams('csv', { search: 'foo', filter: { x: { _eq: 1 } } });
		expect(params['search']).toBe('foo');
		expect(params['filter']).toEqual({ x: { _eq: 1 } });
	});
});

describe('buildExportParams query limit clamp', () => {
	it('clamps a limit above the maximum to the maximum', () => {
		const params = buildExportParams('csv', { limit: 50 }, 10);
		expect(params['limit']).toBe(10);
	});

	it('keeps a limit below the maximum unchanged', () => {
		const params = buildExportParams('csv', { limit: 5 }, 10);
		expect(params['limit']).toBe(5);
	});

	it('passes -1 through unchanged', () => {
		const params = buildExportParams('csv', { limit: -1 }, 10);
		expect(params['limit']).toBe(-1);
	});

	it('defaults an absent limit to -1 with a maximum configured', () => {
		const params = buildExportParams('csv', {}, 10);
		expect(params['limit']).toBe(-1);
	});

	it('keeps a limit of 0 as 0', () => {
		const params = buildExportParams('csv', { limit: 0 }, 10);
		expect(params['limit']).toBe(0);
	});

	it('passes any limit through when no maximum is given', () => {
		const params = buildExportParams('csv', { limit: 5000 });
		expect(params['limit']).toBe(5000);
	});
});

describe('getFilenameFromContentDisposition', () => {
	it('parses quoted filename', () => {
		expect(getFilenameFromContentDisposition('attachment; filename="Collection 2026-05-18.csv"')).toBe(
			'Collection 2026-05-18.csv'
		);
	});

	it('parses unquoted filename', () => {
		expect(getFilenameFromContentDisposition('attachment; filename=Collection.csv')).toBe('Collection.csv');
	});

	it("parses RFC 5987 encoded filename (filename*=UTF-8'')", () => {
		expect(getFilenameFromContentDisposition("attachment; filename*=UTF-8''Collection%202026-05-18.csv")).toBe(
			'Collection 2026-05-18.csv'
		);
	});

	it('returns null for missing header', () => {
		expect(getFilenameFromContentDisposition(undefined)).toBeNull();
		expect(getFilenameFromContentDisposition(null)).toBeNull();
		expect(getFilenameFromContentDisposition('')).toBeNull();
	});

	it('returns null for header without a filename directive', () => {
		expect(getFilenameFromContentDisposition('attachment')).toBeNull();
	});
});

describe('downloadLocalExport', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('calls api.get with responseType blob and no access_token in params', async () => {
		(api.get as any).mockResolvedValue({ data: new Blob(['x']), headers: {} });

		await downloadLocalExport('notes', 'csv', {});

		const call = (api.get as any).mock.calls[0];
		expect(call[1].responseType).toBe('blob');
		expect(call[1].params).not.toHaveProperty('access_token');
		expect(call[1].params.export).toBe('csv');
	});

	it('invokes saveAs with the response blob', async () => {
		const blob = new Blob(['x']);
		(api.get as any).mockResolvedValue({ data: blob, headers: {} });

		await downloadLocalExport('notes', 'csv', {});

		expect(saveAs).toHaveBeenCalledTimes(1);
		const [arg0, arg1] = (saveAs as any).mock.calls[0];
		expect(arg0).toBe(blob);
		expect(typeof arg1).toBe('string');
	});

	it('uses Content-Disposition filename when present', async () => {
		(api.get as any).mockResolvedValue({
			data: new Blob(['x']),
			headers: { 'content-disposition': 'attachment; filename="Collection 2026-05-18.csv"' },
		});

		await downloadLocalExport('notes', 'csv', {});

		expect((saveAs as any).mock.calls[0][1]).toBe('Collection 2026-05-18.csv');
	});

	it('falls back to collection.format when Content-Disposition is missing', async () => {
		(api.get as any).mockResolvedValue({ data: new Blob(['x']), headers: {} });

		await downloadLocalExport('notes', 'csv', {});

		expect((saveAs as any).mock.calls[0][1]).toBe('notes.csv');
	});

	it('passes sort/fields/search/filter/limit through', async () => {
		(api.get as any).mockResolvedValue({ data: new Blob(['x']), headers: {} });

		await downloadLocalExport('notes', 'json', {
			sort: '-id',
			fields: ['id', 'title'],
			search: 'foo',
			filter: { x: { _eq: 1 } },
			limit: 50,
		});

		const params = (api.get as any).mock.calls[0][1].params;

		expect(params).toEqual({
			export: 'json',
			sort: '-id',
			fields: ['id', 'title'],
			search: 'foo',
			filter: { x: { _eq: 1 } },
			limit: 50,
		});
	});
});
