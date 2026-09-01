import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteTokenError, resolveRemoteToken } from './remote-token.js';

const posix = process.platform !== 'win32';

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), 'cairncms-token-'));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function base() {
	return { envToken: undefined, tokenFile: undefined, tokenStdin: false, readStdin: () => 'from-stdin' };
}

describe('resolveRemoteToken', () => {
	it('reads a token from the environment', () => {
		expect(resolveRemoteToken({ ...base(), envToken: 'env-token' })).toBe('env-token');
	});

	it('reads a token from a permission-restricted file', () => {
		const file = path.join(dir, 'good.token');
		writeFileSync(file, 'file-token\n');
		if (posix) chmodSync(file, 0o600);

		expect(resolveRemoteToken({ ...base(), tokenFile: file })).toBe('file-token');
	});

	it('reads a token from stdin', () => {
		expect(resolveRemoteToken({ ...base(), tokenStdin: true, readStdin: () => 'stdin-token\n' })).toBe('stdin-token');
	});

	it('accepts a symlink to a permission-restricted file', () => {
		const target = path.join(dir, 'target.token');
		const link = path.join(dir, 'link.token');
		writeFileSync(target, 'linked-token\n');
		if (posix) chmodSync(target, 0o600);
		symlinkSync(target, link);

		expect(resolveRemoteToken({ ...base(), tokenFile: link })).toBe('linked-token');
	});

	it('rejects when no source is provided', () => {
		expect(() => resolveRemoteToken(base())).toThrow(RemoteTokenError);
	});

	it('rejects when more than one source is provided', () => {
		expect(() => resolveRemoteToken({ ...base(), envToken: 'a', tokenStdin: true })).toThrow(RemoteTokenError);
	});

	it('strips a single trailing LF or CRLF only', () => {
		expect(resolveRemoteToken({ ...base(), envToken: 'tok\n' })).toBe('tok');
		expect(resolveRemoteToken({ ...base(), envToken: 'tok\r\n' })).toBe('tok');
	});

	it('rejects an empty token', () => {
		expect(() => resolveRemoteToken({ ...base(), envToken: '\n' })).toThrow(RemoteTokenError);
	});

	it('rejects a token with an embedded line break without echoing it', () => {
		const secret = 'aaa\nbbb';
		let message = '';

		try {
			resolveRemoteToken({ ...base(), envToken: secret });
		} catch (err) {
			message = (err as Error).message;
		}

		expect(message).not.toBe('');
		expect(message).not.toContain('aaa');
		expect(message).not.toContain('bbb');
	});

	it.skipIf(!posix)('rejects a token file readable by group or others', () => {
		const file = path.join(dir, 'loose.token');
		writeFileSync(file, 'loose-token\n');
		chmodSync(file, 0o644);

		expect(() => resolveRemoteToken({ ...base(), tokenFile: file })).toThrow(/group or others/i);
	});

	it('rejects a missing token file', () => {
		expect(() => resolveRemoteToken({ ...base(), tokenFile: path.join(dir, 'nope.token') })).toThrow(RemoteTokenError);
	});
});
