import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMachineOutput, detectMachineOutput } from './machine-output.js';

describe('detectMachineOutput', () => {
	it('detects a config command asking for JSON output', () => {
		expect(detectMachineOutput(['config', 'apply', './config', '--dry-run', '--format', 'json'])).toBe(true);
	});

	it('detects the joined --format=json form', () => {
		expect(detectMachineOutput(['config', 'apply', './config', '--format=json'])).toBe(true);
	});

	it('ignores a config command without JSON output', () => {
		expect(detectMachineOutput(['config', 'apply', './config', '--format', 'human'])).toBe(false);
		expect(detectMachineOutput(['config', 'apply', './config'])).toBe(false);
	});

	it('ignores JSON output on a non-config command', () => {
		expect(detectMachineOutput(['schema', 'apply', '--format', 'json'])).toBe(false);
	});
});

describe('applyMachineOutput', () => {
	beforeEach(() => {
		vi.stubEnv('CAIRNCMS_LOG_DESTINATION_FD', undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('sets the stderr destination for a config JSON run', () => {
		applyMachineOutput(['config', 'apply', './config', '--format', 'json']);

		expect(process.env['CAIRNCMS_LOG_DESTINATION_FD']).toBe('2');
	});

	it('leaves the destination unset otherwise', () => {
		applyMachineOutput(['config', 'apply', './config']);

		expect(process.env['CAIRNCMS_LOG_DESTINATION_FD']).toBeUndefined();
	});
});
