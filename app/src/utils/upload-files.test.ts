import { uploadFile } from '@/utils/upload-file';
import { describe, expect, it, vi } from 'vitest';
import { uploadFiles } from './upload-files';

vi.mock('@/utils/upload-file');
vi.mock('@/utils/notify', () => ({ notify: vi.fn() }));
vi.mock('@/lang', () => ({ i18n: { global: { t: vi.fn(() => '') } } }));

describe('uploadFiles', () => {
	it('drops files whose upload returned null or undefined', async () => {
		const good = { id: 'good' };

		vi.mocked(uploadFile)
			.mockResolvedValueOnce(good as never)
			.mockResolvedValueOnce(null as never)
			.mockResolvedValueOnce(undefined as never);

		const files = [{}, {}, {}] as unknown as File[];
		const result = await uploadFiles(files);

		expect(result).toEqual([good]);
	});
});
