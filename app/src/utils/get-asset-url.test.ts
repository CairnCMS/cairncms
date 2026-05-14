import { getAssetUrl } from '@/utils/get-asset-url';
import { cryptoStub } from '@/__utils__/crypto';
import { expect, test, vi } from 'vitest';
import { getPublicURL } from '@/utils/get-root-path';
import { URL } from 'node:url';

vi.stubGlobal('crypto', cryptoStub);
vi.mock('@/utils/get-root-path');

Object.defineProperty(window, 'URL', {
	value: URL,
});

test('Get asset url returns bare URL without access_token query', () => {
	vi.mocked(getPublicURL).mockReturnValueOnce('https://example.com/');
	const output = getAssetUrl('test.jpg');
	expect(output).toBe('https://example.com/assets/test.jpg');
	expect(new URL(output).searchParams.has('access_token')).toBe(false);
});

test('Get asset url for download keeps the download flag and omits access_token', () => {
	vi.mocked(getPublicURL).mockReturnValueOnce('https://example.com/');
	const output = getAssetUrl('test.jpg', true);
	expect(output).toBe('https://example.com/assets/test.jpg?download=');
	expect(new URL(output).searchParams.has('access_token')).toBe(false);
});

test('Subdirectory Install: Get asset url returns bare URL', () => {
	vi.mocked(getPublicURL).mockReturnValueOnce('https://example.com/subdirectory/');
	const output = getAssetUrl('test.jpg');
	expect(output).toBe('https://example.com/subdirectory/assets/test.jpg');
	expect(new URL(output).searchParams.has('access_token')).toBe(false);
});

test('Subdirectory Install: Get asset url for download omits access_token', () => {
	vi.mocked(getPublicURL).mockReturnValueOnce('https://example.com/subdirectory/');
	const output = getAssetUrl('test.jpg', true);
	expect(output).toBe('https://example.com/subdirectory/assets/test.jpg?download=');
	expect(new URL(output).searchParams.has('access_token')).toBe(false);
});
