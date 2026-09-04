import { describe, expect, it } from 'vitest';
import { detectRemoteConfigCommand } from './detect-remote.js';

describe('detectRemoteConfigCommand', () => {
	it('detects config apply with --url and a value', () => {
		expect(detectRemoteConfigCommand(['config', 'apply', './cfg', '--url', 'https://host'])).toBe(true);
	});

	it('detects config snapshot with --url=value', () => {
		expect(detectRemoteConfigCommand(['config', 'snapshot', './cfg', '--url=https://host'])).toBe(true);
	});

	it('detects regardless of option ordering', () => {
		expect(detectRemoteConfigCommand(['config', 'apply', '--yes', '--url', 'https://host', './cfg'])).toBe(true);
	});

	it('treats a bare --url as remote intent even without a value', () => {
		expect(detectRemoteConfigCommand(['config', 'apply', './cfg', '--url'])).toBe(true);
	});

	it('does not detect a local config command', () => {
		expect(detectRemoteConfigCommand(['config', 'apply', './cfg'])).toBe(false);
		expect(detectRemoteConfigCommand(['config', 'snapshot', './cfg'])).toBe(false);
	});

	it('does not detect a --url after the argument terminator', () => {
		expect(detectRemoteConfigCommand(['config', 'apply', './cfg', '--', '--url', 'https://host'])).toBe(false);
	});

	it('does not detect other commands or subcommands', () => {
		expect(detectRemoteConfigCommand(['bootstrap', '--url', 'https://host'])).toBe(false);
		expect(detectRemoteConfigCommand(['config', 'diff', '--url', 'https://host'])).toBe(false);
		expect(detectRemoteConfigCommand(['--url', 'https://host'])).toBe(false);
	});
});
