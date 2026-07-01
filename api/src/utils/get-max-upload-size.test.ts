import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMaxUploadSize } from './get-max-upload-size.js';

const factoryEnv: { [k: string]: any } = {};

vi.mock('../env.js', () => ({
	default: new Proxy(
		{},
		{
			get(_target, prop) {
				return factoryEnv[prop as string];
			},
		}
	),
}));

afterEach(() => {
	delete factoryEnv['FILES_MAX_UPLOAD_SIZE'];
});

describe('getMaxUploadSize', () => {
	it('returns undefined when unset (no limit)', () => {
		expect(getMaxUploadSize()).toBeUndefined();
	});

	it('resolves a valid whole-number cap', () => {
		factoryEnv['FILES_MAX_UPLOAD_SIZE'] = '10mb';
		expect(getMaxUploadSize()).toBe(10 * 1024 * 1024);

		factoryEnv['FILES_MAX_UPLOAD_SIZE'] = '500kb';
		expect(getMaxUploadSize()).toBe(500 * 1024);

		factoryEnv['FILES_MAX_UPLOAD_SIZE'] = '5tb';
		expect(getMaxUploadSize()).toBe(5 * 1024 ** 4);
	});

	it('throws on a malformed, decimal, or non-positive value (fails boot, not first upload)', () => {
		for (const bad of ['10mbb', '1gib', '1.5mb', 'bad', '0', '-5mb']) {
			factoryEnv['FILES_MAX_UPLOAD_SIZE'] = bad;
			expect(() => getMaxUploadSize()).toThrow(/FILES_MAX_UPLOAD_SIZE/);
		}
	});
});
