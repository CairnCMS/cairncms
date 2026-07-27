import { normalizeRoleKey } from '@cairncms/utils';
import { promises as fs } from 'fs';
import path from 'path';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import { safeLogFragment } from './safe-log-fragment.js';

export type ConfigKind = 'roles' | 'permissions';

export type ConfigEntry = { kind: 'absent' } | { kind: 'file'; real: string } | { kind: 'directory'; real: string };

/** Mirrors the length of `directus_roles.key`, which a record filename stem becomes. */
const ROLE_KEY_MAX_LENGTH = 255;

/** Reserved as a permission subject, so it is never the key of a stored role. */
const RESERVED_ROLE_KEYS = new Set(['public']);

const TEMPORARY_SUFFIX = '.tmp';

function errnoOf(err: unknown): string {
	return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : 'unknown';
}

function labelFor(root: string, target: string): string {
	return safeLogFragment(path.relative(root, target) || path.basename(target));
}

/**
 * Both arguments must already be resolved. Comparing unresolved paths would accept a link inside the
 * tree whose target sits outside it. The root itself passes, since the manifest lives directly in it.
 */
export function assertContained(root: string, real: string, label: string): void {
	const relative = path.relative(root, real);
	const escapes = relative === '..' || relative.startsWith(`..${path.sep}`);

	if (escapes || path.isAbsolute(relative)) {
		throw new ConfigInvalidException(`Config path "${safeLogFragment(label)}" resolves outside the config directory.`);
	}
}

/**
 * Absence is the only result a caller may treat as an empty set, so everything else fails instead.
 * `readdir` reports a dangling symlink as ENOENT, indistinguishable from a kind directory the
 * operator never created.
 */
export async function classifyConfigEntry(root: string, target: string): Promise<ConfigEntry> {
	const label = labelFor(root, target);

	try {
		await fs.lstat(target);
	} catch (err) {
		if (errnoOf(err) === 'ENOENT') return { kind: 'absent' };

		throw new ConfigReadFailedException(`Config path "${label}" could not be read (${errnoOf(err)}).`);
	}

	let real: string;

	try {
		real = await fs.realpath(target);
	} catch (err) {
		if (errnoOf(err) === 'ENOENT') {
			throw new ConfigInvalidException(`Config path "${label}" is a link that does not resolve.`);
		}

		throw new ConfigReadFailedException(`Config path "${label}" could not be resolved (${errnoOf(err)}).`);
	}

	assertContained(root, real, label);

	let info;

	try {
		info = await fs.stat(real);
	} catch (err) {
		throw new ConfigReadFailedException(`Config path "${label}" could not be read (${errnoOf(err)}).`);
	}

	if (info.isFile()) return { kind: 'file', real };
	if (info.isDirectory()) return { kind: 'directory', real };

	throw new ConfigInvalidException(`Config path "${label}" is neither a regular file nor a directory.`);
}

/** `read` requires the directory to exist, so a mistyped path fails rather than reading as empty. `write` creates it. */
export async function resolveConfigRoot(input: string, mode: 'read' | 'write'): Promise<string> {
	const absolute = path.resolve(input);

	if (mode === 'write') {
		try {
			await fs.mkdir(absolute, { recursive: true });
		} catch (err) {
			const errno = errnoOf(err);

			if (errno === 'EEXIST' || errno === 'ENOTDIR') {
				throw new ConfigInvalidException(`Config directory "${safeLogFragment(input)}" exists but is not a directory.`);
			}

			throw new ConfigReadFailedException(
				`Config directory "${safeLogFragment(input)}" could not be created (${errno}).`
			);
		}
	}

	let real: string;

	try {
		real = await fs.realpath(absolute);
	} catch (err) {
		if (errnoOf(err) === 'ENOENT') {
			throw new ConfigInvalidException(`Config directory "${safeLogFragment(input)}" does not exist.`);
		}

		throw new ConfigReadFailedException(
			`Config directory "${safeLogFragment(input)}" could not be resolved (${errnoOf(err)}).`
		);
	}

	let info;

	try {
		info = await fs.stat(real);
	} catch (err) {
		throw new ConfigReadFailedException(
			`Config directory "${safeLogFragment(input)}" could not be read (${errnoOf(err)}).`
		);
	}

	if (!info.isDirectory()) {
		throw new ConfigInvalidException(`Config directory "${safeLogFragment(input)}" is not a directory.`);
	}

	return real;
}

/** Resolves a path that must be an existing regular file inside the config tree. */
export async function assertSafeFile(root: string, target: string): Promise<string> {
	const entry = await classifyConfigEntry(root, target);

	if (entry.kind === 'absent') {
		throw new ConfigInvalidException(`Config file "${labelFor(root, target)}" does not exist.`);
	}

	if (entry.kind !== 'file') {
		throw new ConfigInvalidException(`Config path "${labelFor(root, target)}" is not a regular file.`);
	}

	return entry.real;
}

/** Resolves a path that must be an existing directory inside the config tree. */
export async function assertSafeDirectory(root: string, target: string): Promise<string> {
	const entry = await classifyConfigEntry(root, target);

	if (entry.kind === 'absent') {
		throw new ConfigInvalidException(`Config directory "${labelFor(root, target)}" does not exist.`);
	}

	if (entry.kind !== 'directory') {
		throw new ConfigInvalidException(`Config path "${labelFor(root, target)}" is not a directory.`);
	}

	return entry.real;
}

/**
 * Whether this kind of record set generates the filename, which is what makes it eligible for
 * stale-file cleanup. A stem the platform would have stored under a different key is not ours to delete.
 */
export function isOwnedConfigFilename(name: string, kind: ConfigKind): boolean {
	if (!name.endsWith('.yaml')) return false;

	const stem = name.slice(0, -'.yaml'.length);

	if (stem === '' || stem.length > ROLE_KEY_MAX_LENGTH) return false;
	if (normalizeRoleKey(stem) !== stem) return false;
	if (kind === 'roles' && RESERVED_ROLE_KEYS.has(stem)) return false;

	return true;
}

/** Reads a file that must resolve to a regular file inside the config tree. */
export async function readContainedFile(root: string, target: string): Promise<string> {
	const real = await assertSafeFile(root, target);

	try {
		return await fs.readFile(real, 'utf8');
	} catch (err) {
		throw new ConfigReadFailedException(`Config file "${labelFor(root, target)}" could not be read (${errnoOf(err)}).`);
	}
}

/**
 * Stages the contents beside the destination and renames over it, so no partially written file is
 * ever in place. A symlinked destination is written through to its target, leaving the link intact.
 *
 * Rename installs a new inode carrying the process umask, so the staging file inherits the mode of
 * the file it replaces. Otherwise a deliberately restricted file would silently widen. The mode is
 * applied before any contents are written, so the restriction never lags the data it protects.
 *
 * Staging is created exclusively, so a leftover from an interrupted run is reported, not overwritten.
 */
export async function replaceFileAtomically(root: string, target: string, contents: string): Promise<void> {
	const entry = await classifyConfigEntry(root, target);

	if (entry.kind === 'directory') {
		throw new ConfigInvalidException(`Config path "${labelFor(root, target)}" is a directory.`);
	}

	let destination: string;
	let inheritedMode: number | undefined;

	if (entry.kind === 'file') {
		destination = entry.real;

		try {
			inheritedMode = (await fs.stat(destination)).mode & 0o777;
		} catch (err) {
			throw new ConfigReadFailedException(
				`Config file "${labelFor(root, target)}" could not be read (${errnoOf(err)}).`
			);
		}
	} else {
		const realParent = await assertSafeDirectory(root, path.dirname(target));
		destination = path.join(realParent, path.basename(target));
		assertContained(root, destination, labelFor(root, target));
	}

	const staging = `${destination}${TEMPORARY_SUFFIX}`;
	let handle;

	try {
		handle = inheritedMode === undefined ? await fs.open(staging, 'wx') : await fs.open(staging, 'wx', inheritedMode);
	} catch (err) {
		if (errnoOf(err) === 'EEXIST') {
			throw new ConfigInvalidException(
				`A leftover staging file "${labelFor(root, staging)}" is present. Remove it and run again.`
			);
		}

		throw new ConfigReadFailedException(
			`Config file "${labelFor(root, target)}" could not be staged (${errnoOf(err)}).`
		);
	}

	try {
		if (inheritedMode !== undefined) await handle.chmod(inheritedMode);
		await handle.writeFile(contents, 'utf8');
		await handle.close();
	} catch (err) {
		await handle.close().catch(() => undefined);
		await fs.unlink(staging).catch(() => undefined);

		throw new ConfigReadFailedException(
			`Config file "${labelFor(root, target)}" could not be written (${errnoOf(err)}).`
		);
	}

	try {
		await fs.rename(staging, destination);
	} catch (err) {
		await fs.unlink(staging).catch(() => undefined);

		throw new ConfigReadFailedException(
			`Config file "${labelFor(root, target)}" could not be replaced (${errnoOf(err)}).`
		);
	}
}
