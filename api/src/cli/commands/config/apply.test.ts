import { afterEach, describe, expect, it, vi } from 'vitest';
import getDatabase from '../../../database/index.js';
import logger from '../../../logger.js';
import { readConfigDirectory } from '../../../utils/read-config-directory.js';
import { configApply } from './apply.js';

vi.mock('../../../database/index.js', () => ({
	default: vi.fn(() => ({ destroy: vi.fn() })),
	isInstalled: vi.fn(async () => true),
	validateDatabaseConnection: vi.fn(async () => undefined),
}));

vi.mock('../../../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock('../../../utils/read-config-directory.js', () => ({
	readConfigDirectory: vi.fn(),
	isPlaceholder: vi.fn(() => false),
}));

describe('configApply usage ordering', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('rejects --format json without --dry-run before constructing the database or reading the config path', async () => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		await expect(
			configApply('./config', { format: 'json', dryRun: false, destructive: false, yes: false })
		).rejects.toThrow('exit:2');

		expect(logger.error).toHaveBeenCalledWith('JSON output is only available with --dry-run.');
		expect(getDatabase).not.toHaveBeenCalled();
		expect(readConfigDirectory).not.toHaveBeenCalled();
	});
});
