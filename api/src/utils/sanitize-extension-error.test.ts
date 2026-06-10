import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeExtensionError } from './sanitize-extension-error.js';

describe('sanitizeExtensionError', () => {
	afterEach(() => {
		delete process.env['SANITIZER_TEST_VALUE'];
	});

	it('uses the message first line and never the stack', () => {
		const error = new Error('registration failed');
		error.stack = 'registration failed\n    at handler (/opt/app/secret/file.js:10:5)';

		const { detail } = sanitizeExtensionError(error);

		expect(detail).toBe('registration failed');
		expect(detail).not.toContain('file.js');
		expect(detail).not.toContain('at handler');
	});

	it('redacts POSIX absolute paths', () => {
		const { detail } = sanitizeExtensionError(new Error("Cannot find module '/opt/secret/module.js'"));

		expect(detail).not.toContain('/opt/secret');
		expect(detail).toContain('<path>');
	});

	it('redacts Windows absolute paths', () => {
		const { detail } = sanitizeExtensionError(new Error('load failed at C:\\Users\\bob\\secret.js'));

		expect(detail).not.toContain('C:\\Users');
		expect(detail).toContain('<path>');
	});

	it('redacts environment values over the length threshold', () => {
		process.env['SANITIZER_TEST_VALUE'] = 'env_value_xyz';

		const { detail } = sanitizeExtensionError(new Error('boom env_value_xyz boom'));

		expect(detail).not.toContain('env_value_xyz');
		expect(detail).toContain('<redacted>');
	});

	it('redacts long secret-shaped tokens', () => {
		const token = 'A1b2C3d4E5f6G7h8I9j0K1l2';

		const { detail } = sanitizeExtensionError(new Error(`token ${token} leaked`));

		expect(detail).not.toContain(token);
	});

	it('leads with a stable code and derives ENTRYPOINT_NOT_FOUND from the error code', () => {
		const notFound = Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' });

		expect(sanitizeExtensionError(notFound, 'REGISTRATION_FAILED').code).toBe('ENTRYPOINT_NOT_FOUND');
		expect(sanitizeExtensionError(new Error('x'), 'REGISTRATION_FAILED').code).toBe('REGISTRATION_FAILED');
	});

	it('collapses whitespace and truncates long detail', () => {
		const { detail } = sanitizeExtensionError(new Error('a'.repeat(500)));

		expect(detail.length).toBeLessThanOrEqual(300);
	});
});
