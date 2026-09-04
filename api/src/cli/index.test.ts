import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initialize = vi.fn(async () => undefined);

vi.mock('../extensions.js', () => ({ getExtensionManager: () => ({ initialize }) }));
vi.mock('../emitter.js', () => ({ default: { emitInit: vi.fn(async () => undefined) } }));
vi.mock('../server.js', () => ({ startServer: vi.fn() }));

import { createCli } from './index.js';

const ORIGINAL_ARGV = process.argv;

function argv(...args: string[]): void {
	process.argv = ['node', 'cairncms', ...args];
}

beforeEach(() => {
	initialize.mockClear();
});

afterEach(() => {
	process.argv = ORIGINAL_ARGV;
});

describe('createCli extension initialization gate', () => {
	it('skips extension initialization for a remote config apply', async () => {
		argv('config', 'apply', './cfg', '--url', 'https://cms.example');
		await createCli();
		expect(initialize).not.toHaveBeenCalled();
	});

	it('skips extension initialization for a remote config snapshot', async () => {
		argv('config', 'snapshot', './cfg', '--url', 'https://cms.example');
		await createCli();
		expect(initialize).not.toHaveBeenCalled();
	});

	it('initializes extensions for a local config apply without --url', async () => {
		argv('config', 'apply', './cfg');
		await createCli();
		expect(initialize).toHaveBeenCalledOnce();
	});

	it('skips extension initialization for init', async () => {
		argv('init');
		await createCli();
		expect(initialize).not.toHaveBeenCalled();
	});
});
