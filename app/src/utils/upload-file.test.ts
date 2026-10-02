import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiPatch = vi.fn();
const apiPost = vi.fn();

vi.mock('@/api', () => ({
	default: {
		patch: (...args: unknown[]) => apiPatch(...args),
		post: (...args: unknown[]) => apiPost(...args),
	},
}));

vi.mock('@/events', () => ({ default: { emit: vi.fn() }, Events: { upload: 'upload' } }));
vi.mock('@/utils/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lang', () => ({ i18n: { global: { t: vi.fn(() => '') } } }));
vi.mock('@/utils/unexpected-error', () => ({ unexpectedError: vi.fn() }));

import { uploadFile } from './upload-file';

beforeEach(() => {
	apiPatch.mockReset();
	apiPost.mockReset();
});

describe('uploadFile', () => {
	it('replaces via PATCH and returns the record on a 200', async () => {
		apiPatch.mockResolvedValue({ status: 200, data: { data: { id: 'file-1', title: 'kept' } } });

		const result = await uploadFile(new File(['x'], 'a.png'), { fileId: 'file-1' });

		expect(apiPatch).toHaveBeenCalledWith('/files/file-1', expect.anything(), expect.anything());
		expect(result).toEqual({ id: 'file-1', title: 'kept' });
	});

	it('reports the target id on a 204 replace without read permission', async () => {
		apiPatch.mockResolvedValue({ status: 204, data: '' });

		const result = await uploadFile(new File(['x'], 'a.png'), { fileId: 'file-1' });

		expect(result).toEqual({ id: 'file-1' });
	});

	it('creates via POST for a new upload and does not synthesize an id', async () => {
		apiPost.mockResolvedValue({ status: 200, data: { data: { id: 'new-1' } } });

		const result = await uploadFile(new File(['x'], 'a.png'));

		expect(apiPost).toHaveBeenCalledWith('/files', expect.anything(), expect.anything());
		expect(result).toEqual({ id: 'new-1' });
	});
});
