import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, constants, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RemoteTokenError, resolveRemoteToken } from './remote-token.js';

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return { ...actual, openSync: vi.fn(actual.openSync) };
});

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

	it.skipIf(!posix)('opens the token file non-blocking, passing O_NONBLOCK', () => {
		const file = path.join(dir, 'nonblock.token');
		writeFileSync(file, 'nb-token\n');
		chmodSync(file, 0o600);

		vi.mocked(openSync).mockClear();
		expect(resolveRemoteToken({ ...base(), tokenFile: file })).toBe('nb-token');

		const flags = vi.mocked(openSync).mock.calls[0]![1] as number;
		expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
	});

	it.skipIf(!posix)('does not block on a FIFO with no writer and rejects it as not a regular file', () => {
		const fifo = path.join(dir, 'blocking.fifo');
		execFileSync('mkfifo', [fifo]);

		const sut = fileURLToPath(new URL('./remote-token.ts', import.meta.url));
		const script = path.join(dir, 'fifo-child.mts');

		writeFileSync(
			script,
			[
				`import { resolveRemoteToken, RemoteTokenError } from ${JSON.stringify(sut)};`,
				`try {`,
				`	resolveRemoteToken({ envToken: undefined, tokenFile: process.argv[2], tokenStdin: false, readStdin: () => '' });`,
				`	process.stdout.write('RESOLVED');`,
				`	process.exit(1);`,
				`} catch (err) {`,
				`	if (err instanceof RemoteTokenError && /not a regular file/i.test(err.message)) {`,
				`		process.stdout.write('NOT_REGULAR_FILE');`,
				`		process.exit(0);`,
				`	}`,
				`	process.stdout.write('UNEXPECTED:' + (err && err.message));`,
				`	process.exit(2);`,
				`}`,
			].join('\n')
		);

		const child = spawnSync(process.execPath, ['--import', 'tsx', script, fifo], { timeout: 10000, encoding: 'utf8' });

		expect(child.signal).toBeNull();
		expect(child.status).toBe(0);
		expect(child.stdout).toContain('NOT_REGULAR_FILE');
	});
});
