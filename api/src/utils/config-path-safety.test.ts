import { promises as fs } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import {
	assertContained,
	assertSafeDirectory,
	assertSafeFile,
	classifyConfigEntry,
	readContainedDirectory,
	readContainedFile,
	replaceFileAtomically,
	resolveConfigRoot,
} from './config-path-safety.js';

let tmpDir: string;
let root: string;
let outside: string;

beforeEach(async () => {
	tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-path-test-')));
	root = path.join(tmpDir, 'config');
	outside = path.join(tmpDir, 'outside');
	await fs.mkdir(path.join(root, 'roles'), { recursive: true });
	await fs.mkdir(outside, { recursive: true });
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('assertContained', () => {
	it('rejects a parent traversal, an unrelated absolute path, and a sibling directory sharing the prefix', () => {
		expect(() => assertContained(root, path.join(root, '..', 'outside', 'x.yaml'), 'x')).toThrow(
			ConfigInvalidException
		);

		expect(() => assertContained(root, path.join(path.sep, 'etc', 'passwd'), 'x')).toThrow(ConfigInvalidException);
		expect(() => assertContained(root, `${root}-other`, 'x')).toThrow(ConfigInvalidException);
	});

	it('accepts the root itself and a path beneath it', () => {
		expect(() => assertContained(root, root, 'x')).not.toThrow();
		expect(() => assertContained(root, path.join(root, 'roles', 'editor.yaml'), 'x')).not.toThrow();
	});

	it('accepts a contained name that begins with two dots', () => {
		expect(() => assertContained(root, path.join(root, '..shared', 'editor.yaml'), 'x')).not.toThrow();
	});
});

describe('classifyConfigEntry', () => {
	it('reports a missing entry as absent', async () => {
		await expect(classifyConfigEntry(root, path.join(root, 'roles', 'missing.yaml'))).resolves.toEqual({
			kind: 'absent',
		});
	});

	it('refuses a link that does not resolve rather than reporting it as absent', async () => {
		const link = path.join(root, 'roles', 'dangling.yaml');
		await fs.symlink(path.join(root, 'roles', 'gone.yaml'), link);

		await expect(classifyConfigEntry(root, link)).rejects.toThrow(ConfigInvalidException);
	});

	it('refuses a kind directory whose link does not resolve, which would otherwise read as an empty kind', async () => {
		const link = path.join(root, 'permissions');
		await fs.symlink(path.join(tmpDir, 'never-created'), link);

		await expect(classifyConfigEntry(root, link)).rejects.toThrow(ConfigInvalidException);
	});

	it('refuses a link whose target leaves the config directory', async () => {
		const secret = path.join(outside, 'secret.yaml');
		await fs.writeFile(secret, 'key: value\n');
		const link = path.join(root, 'roles', 'escape.yaml');
		await fs.symlink(secret, link);

		await expect(classifyConfigEntry(root, link)).rejects.toThrow(ConfigInvalidException);
	});

	it('accepts a link resolving inside the config directory and reports its target', async () => {
		const real = path.join(root, 'shared.yaml');
		await fs.writeFile(real, 'key: value\n');
		const link = path.join(root, 'roles', 'editor.yaml');
		await fs.symlink(real, link);

		await expect(classifyConfigEntry(root, link)).resolves.toEqual({ kind: 'file', real });
	});

	it('accepts a linked directory resolving inside the config directory', async () => {
		const real = path.join(root, 'shared-permissions');
		await fs.mkdir(real);
		const link = path.join(root, 'permissions');
		await fs.symlink(real, link);

		await expect(classifyConfigEntry(root, link)).resolves.toEqual({ kind: 'directory', real });
	});

	it('refuses an entry that is neither a regular file nor a directory', async () => {
		const socketPath = path.join(root, 'roles', 'socket.yaml');
		const server = net.createServer();

		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		try {
			await expect(classifyConfigEntry(root, socketPath)).rejects.toThrow(ConfigInvalidException);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('reports an unreadable entry as a read failure rather than as absent', async () => {
		const target = path.join(root, 'roles', 'editor.yaml');
		await fs.writeFile(target, 'key: value\n');

		const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		const lstat = vi.spyOn(fs, 'lstat').mockRejectedValueOnce(denied);

		try {
			await expect(classifyConfigEntry(root, target)).rejects.toThrow(ConfigReadFailedException);
		} finally {
			lstat.mockRestore();
		}
	});
});

describe('resolveConfigRoot', () => {
	it('rejects a directory that does not exist when reading', async () => {
		await expect(resolveConfigRoot(path.join(tmpDir, 'absent'), 'read')).rejects.toThrow(ConfigInvalidException);
	});

	it('creates a directory that does not exist when writing', async () => {
		const target = path.join(tmpDir, 'brand', 'new');

		await expect(resolveConfigRoot(target, 'write')).resolves.toBe(target);
		await expect(fs.stat(target)).resolves.toBeDefined();
	});

	it('resolves a linked root to its target so containment is measured against the real directory', async () => {
		const link = path.join(tmpDir, 'config-link');
		await fs.symlink(root, link);

		await expect(resolveConfigRoot(link, 'read')).resolves.toBe(root);
	});

	it('rejects a path that exists as a file', async () => {
		const file = path.join(tmpDir, 'not-a-directory');
		await fs.writeFile(file, '');

		await expect(resolveConfigRoot(file, 'read')).rejects.toThrow(ConfigInvalidException);
		await expect(resolveConfigRoot(file, 'write')).rejects.toThrow(ConfigInvalidException);
	});
});

describe('readContainedFile', () => {
	it('reads through a link resolving inside the config directory', async () => {
		const real = path.join(root, 'shared.yaml');
		await fs.writeFile(real, 'key: value\n');
		await fs.symlink(real, path.join(root, 'roles', 'editor.yaml'));

		await expect(readContainedFile(root, path.join(root, 'roles', 'editor.yaml'))).resolves.toBe('key: value\n');
	});

	it('refuses to read through a link leaving the config directory', async () => {
		const secret = path.join(outside, 'secret.yaml');
		await fs.writeFile(secret, 'token: value\n');
		await fs.symlink(secret, path.join(root, 'roles', 'escape.yaml'));

		await expect(readContainedFile(root, path.join(root, 'roles', 'escape.yaml'))).rejects.toThrow(
			ConfigInvalidException
		);
	});

	it('refuses a directory', async () => {
		await expect(readContainedFile(root, path.join(root, 'roles'))).rejects.toThrow(ConfigInvalidException);
	});
});

describe('assertSafeFile and assertSafeDirectory', () => {
	it('reject an entry of the wrong type', async () => {
		await expect(assertSafeFile(root, path.join(root, 'roles'))).rejects.toThrow(ConfigInvalidException);

		await expect(assertSafeDirectory(root, path.join(root, 'roles', 'editor.yaml'))).rejects.toThrow(
			ConfigInvalidException
		);
	});

	it('reject an absent entry', async () => {
		await expect(assertSafeFile(root, path.join(root, 'roles', 'missing.yaml'))).rejects.toThrow(
			ConfigInvalidException
		);

		await expect(assertSafeDirectory(root, path.join(root, 'missing'))).rejects.toThrow(ConfigInvalidException);
	});
});

describe('readContainedDirectory', () => {
	it('lists a directory and reports a missing one as absent rather than empty', async () => {
		await fs.writeFile(path.join(root, 'roles', 'editor.yaml'), 'key: editor\n');

		await expect(readContainedDirectory(root, path.join(root, 'roles'))).resolves.toEqual(['editor.yaml']);
		await expect(readContainedDirectory(root, path.join(root, 'permissions'))).resolves.toBeNull();
	});

	it('refuses a link that does not resolve rather than reporting it as absent', async () => {
		await fs.symlink(path.join(tmpDir, 'never-created'), path.join(root, 'permissions'));

		await expect(readContainedDirectory(root, path.join(root, 'permissions'))).rejects.toThrow(ConfigInvalidException);
	});

	it('refuses a file where a directory is expected', async () => {
		await fs.writeFile(path.join(root, 'permissions'), '');

		await expect(readContainedDirectory(root, path.join(root, 'permissions'))).rejects.toThrow(ConfigInvalidException);
	});

	it('reports a listing failure as a read failure rather than as absent', async () => {
		const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		const readdir = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(denied);

		try {
			await expect(readContainedDirectory(root, path.join(root, 'roles'))).rejects.toThrow(ConfigReadFailedException);
		} finally {
			readdir.mockRestore();
		}
	});
});

describe('replaceFileAtomically', () => {
	it('replaces the contents of an existing file', async () => {
		const target = path.join(root, 'roles', 'editor.yaml');
		await fs.writeFile(target, 'old\n');

		await replaceFileAtomically(root, target, 'new\n');

		await expect(fs.readFile(target, 'utf8')).resolves.toBe('new\n');
	});

	it('creates a file that does not exist yet', async () => {
		const target = path.join(root, 'roles', 'editor.yaml');

		await replaceFileAtomically(root, target, 'new\n');

		await expect(fs.readFile(target, 'utf8')).resolves.toBe('new\n');
	});

	it('writes through a linked destination and leaves the link in place', async () => {
		const real = path.join(root, 'shared.yaml');
		await fs.writeFile(real, 'old\n');
		const link = path.join(root, 'roles', 'editor.yaml');
		await fs.symlink(real, link);

		await replaceFileAtomically(root, link, 'new\n');

		await expect(fs.readFile(real, 'utf8')).resolves.toBe('new\n');
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	});

	it('refuses a destination that leaves the config directory', async () => {
		const secret = path.join(outside, 'secret.yaml');
		await fs.writeFile(secret, 'token: value\n');
		const link = path.join(root, 'roles', 'escape.yaml');
		await fs.symlink(secret, link);

		await expect(replaceFileAtomically(root, link, 'new\n')).rejects.toThrow(ConfigInvalidException);
		await expect(fs.readFile(secret, 'utf8')).resolves.toBe('token: value\n');
	});

	it('refuses to run when a staging file from an interrupted run is present', async () => {
		const target = path.join(root, 'roles', 'editor.yaml');
		await fs.writeFile(target, 'old\n');
		await fs.writeFile(`${target}.tmp`, 'partial\n');

		await expect(replaceFileAtomically(root, target, 'new\n')).rejects.toThrow(ConfigInvalidException);
		await expect(fs.readFile(target, 'utf8')).resolves.toBe('old\n');
	});

	it('preserves the mode of the file it replaces', async () => {
		const target = path.join(root, 'roles', 'editor.yaml');
		await fs.writeFile(target, 'old\n');
		await fs.chmod(target, 0o600);

		await replaceFileAtomically(root, target, 'new\n');

		expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
	});

	it('preserves the mode of a linked target it writes through', async () => {
		const real = path.join(root, 'shared.yaml');
		await fs.writeFile(real, 'old\n');
		await fs.chmod(real, 0o600);
		const link = path.join(root, 'roles', 'editor.yaml');
		await fs.symlink(real, link);

		await replaceFileAtomically(root, link, 'new\n');

		expect((await fs.stat(real)).mode & 0o777).toBe(0o600);
	});

	it('leaves the destination intact and removes staging when the write fails', async () => {
		const target = path.join(root, 'roles', 'editor.yaml');
		await fs.writeFile(target, 'old\n');

		const realOpen = fs.open.bind(fs);

		const open = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
			const handle = await realOpen(...args);
			handle.writeFile = () => Promise.reject(Object.assign(new Error('no space left'), { code: 'ENOSPC' }));
			return handle;
		});

		try {
			await expect(replaceFileAtomically(root, target, 'new\n')).rejects.toThrow(ConfigReadFailedException);
		} finally {
			open.mockRestore();
		}

		await expect(fs.readFile(target, 'utf8')).resolves.toBe('old\n');
		await expect(fs.stat(`${target}.tmp`)).rejects.toThrow();
	});

	it('restricts the staging file before writing the contents into it', async () => {
		const target = path.join(root, 'roles', 'editor.yaml');
		await fs.writeFile(target, 'old\n');
		await fs.chmod(target, 0o600);

		let modeAtWrite: number | undefined;
		const realOpen = fs.open.bind(fs);

		const open = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
			const handle = await realOpen(...args);
			const write = handle.writeFile.bind(handle);

			handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
				modeAtWrite = (await fs.stat(`${target}.tmp`)).mode & 0o777;
				return write(...writeArgs);
			};

			return handle;
		});

		try {
			await replaceFileAtomically(root, target, 'new\n');
		} finally {
			open.mockRestore();
		}

		expect(modeAtWrite).toBe(0o600);
	});

	it('leaves no staging file behind after a successful replacement', async () => {
		const target = path.join(root, 'roles', 'editor.yaml');

		await replaceFileAtomically(root, target, 'new\n');

		await expect(fs.stat(`${target}.tmp`)).rejects.toThrow();
	});
});
