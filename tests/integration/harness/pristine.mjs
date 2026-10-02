import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, appendFile, lstat, mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { snapshotCommand, snapshotHash, snapshotInventory, snapshotVendors } from './snapshot.mjs';
import { removeMarkedDirectory } from './owned-directory.mjs';

const read = async (path) => {
	const text = await readFile(path, 'utf8');

	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Invalid pristine metadata: ${basename(path)}`);
	}
};

const save = (path, value) => writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });

const exists = (path) =>
	access(path).then(
		() => true,
		(error) => {
			if (error.code === 'ENOENT') return false;
			throw error;
		}
	);

export async function createPristineStore(reports, identity) {
	const directory = join(tmpdir(), `cairn-integration-template-${randomUUID()}`);
	const owner = { directory, reports, owner: process.pid };
	const record = join(reports, 'pristine.json');
	// Record ownership before allocating the directory so a killed vendor leaves a recoverable path.
	await save(record + '.partial', owner);
	await rename(record + '.partial', record);
	await mkdir(directory, { mode: 0o700 });
	await save(join(directory, '.integration-owner.json'), owner);
	return { directory, buildHash: snapshotHash(identity) };
}

export async function removePristineStore(reports) {
	const record = join(reports, 'pristine.json');
	if (!(await exists(record))) return;
	const owner = await read(record);
	if (
		typeof owner.directory !== 'string' ||
		owner.reports !== reports ||
		dirname(resolve(owner.directory)) !== resolve(tmpdir()) ||
		!/^cairn-integration-template-[a-f0-9-]{36}$/.test(basename(owner.directory))
	)
		throw new Error('Invalid pristine directory ownership');

	const info = await lstat(owner.directory).catch((error) => {
		if (error.code === 'ENOENT') return;
		throw error;
	});

	if (!info) return;
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe pristine directory');
	const marker = join(owner.directory, '.integration-owner.json');

	if (!(await exists(marker))) {
		// Marker creation and removal can each leave an empty directory after a crash.
		await rmdir(owner.directory);
	} else {
		assert.deepEqual(await read(marker), owner, 'Pristine directory ownership mismatch');
		await removeMarkedDirectory(owner.directory);
	}
}

// These settings leave the initial database unchanged. Unknown settings retain
// real bootstrap; fixture authors do not need to opt into restoration.
export const runtimeSettings = Object.freeze([
	'CACHE_SCHEMA',
	'CACHE_ENABLED',
	'CACHE_AUTO_PURGE',
	'CACHE_AUTO_PURGE_IGNORE_LIST',
	'CACHE_STORE',
	'CACHE_STATUS_HEADER',
	'CACHE_NAMESPACE',
	'FILES_MAX_UPLOAD_SIZE',
	'FILES_MIME_TYPE_ALLOW_LIST',
	'ASSETS_TRANSFORM_MAX_CONCURRENT',
	'STORAGE_LOCATIONS',
	'STORAGE_S3_DRIVER',
	'STORAGE_S3_KEY',
	'STORAGE_S3_SECRET',
	'STORAGE_S3_BUCKET',
	'STORAGE_S3_REGION',
	'STORAGE_S3_ENDPOINT',
	'STORAGE_S3_FORCE_PATH_STYLE',
]);

export function canRestore(runtime, options = {}) {
	return (
		snapshotVendors.includes(runtime.vendor) &&
		!!runtime.pristine &&
		options.bootstrap !== 'fresh' &&
		Object.keys(options.env ?? {}).every((key) => runtimeSettings.includes(key)) &&
		(!options.env?.CACHE_STORE || options.env.CACHE_STORE === 'memory') &&
		!options.absoluteOrigin &&
		!options.origin &&
		!options.extensions?.length &&
		!options.migrations?.length
	);
}

export async function initializeDatabase({ runtime, id, env, database, bootstrap, signal, options, createDatabase }) {
	const eligible = canRestore(runtime, options) && !(await readdir(env.EXTENSIONS_PATH)).length;
	const deadline = performance.now() + 90_000;
	const cancellation = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90_000)]);
	const started = performance.now();

	const record = (type, detail = {}) =>
		appendFile(
			join(runtime.directory, 'provisioning.jsonl'),
			JSON.stringify({ type, id, worker: process.pid, monotonicNs: process.hrtime.bigint().toString(), ...detail }) +
				'\n'
		);

	let operation = 'bootstrap';
	let complete = false;

	try {
		if (!eligible) {
			await record('bootstrap', { reason: 'fixture-or-vendor' });
			await createDatabase?.();
			await bootstrap(cancellation);
			cancellation.throwIfAborted();
			complete = true;
			return;
		}

		const { directory, buildHash } = runtime.pristine;
		const ready = join(directory, 'ready.json');
		const failed = join(directory, 'failed.json');
		const dump = join(directory, 'pristine.snapshot');
		const claim = join(directory, 'claim');
		const ignored = new Set(['KEY', 'SECRET', 'DB_DATABASE', 'DB_FILENAME', 'STORAGE_LOCAL_ROOT', 'EXTENSIONS_PATH']);

		const recipeHash = snapshotHash(
			Object.fromEntries(
				Object.entries(env)
					.filter(([key]) => !ignored.has(key) && !runtimeSettings.includes(key))
					.sort(([a], [b]) => a.localeCompare(b))
			)
		);

		const container = runtime.vendor === 'sqlite3' ? undefined : await read(join(runtime.directory, 'container.json'));

		const command = (operation, input) =>
			snapshotCommand({
				vendor: runtime.vendor,
				container: container?.id,
				filename: env.DB_FILENAME,
				database: id,
				password: env.DB_PASSWORD,
				template: `test_template_${basename(directory)
					.slice('cairn-integration-template-'.length)
					.replaceAll('-', '')}`,
				operation,
				input,
				signal: cancellation,
				record,
			});

		let creator = false;

		try {
			await mkdir(claim, { mode: 0o700 });
			creator = true;
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
		}

		if (creator) {
			await save(join(claim, 'owner.partial'), { pid: process.pid });
			await rename(join(claim, 'owner.partial'), join(claim, 'owner.json'));
			await record('claimed');

			try {
				await record('bootstrap', { reason: 'template-creator' });
				await createDatabase?.();
				await bootstrap(cancellation);
				const sql = await command('export');
				await writeFile(dump + '.partial', sql, { mode: 0o600 });
				const snapshot = await snapshotInventory(database, id, cancellation, { vendor: runtime.vendor, deadline });

				const metadata = {
					buildHash,
					recipeHash,
					dumpHash: snapshotHash(sql),
					snapshotHash: snapshotHash(snapshot),
					snapshot,
				};

				await save(ready + '.partial', metadata);
				cancellation.throwIfAborted();
				await rename(dump + '.partial', dump);
				await rename(ready + '.partial', ready);
				await record('published', { dumpHash: metadata.dumpHash, snapshotHash: metadata.snapshotHash });
			} catch (error) {
				await save(failed, { reason: 'Pristine template creation failed' });
				await record('creator-failed');
				throw error;
			}
		} else {
			await record('waiting');

			while (!(await exists(ready))) {
				cancellation.throwIfAborted();
				if (await exists(failed)) throw new Error('Pristine template creator failed');

				try {
					const owner = await read(join(claim, 'owner.json'));

					try {
						process.kill(owner.pid, 0);
					} catch (error) {
						if (error.code === 'ESRCH') throw new Error('Pristine template creator exited before publication');
						throw error;
					}
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
				}

				await delay(25, undefined, { signal: cancellation });
			}

			const metadata = await read(ready);
			if (
				!metadata ||
				['buildHash', 'recipeHash', 'dumpHash', 'snapshotHash'].some(
					(field) => typeof metadata[field] !== 'string' || !/^[a-f0-9]{64}$/.test(metadata[field])
				)
			)
				throw new Error('Invalid pristine metadata: ready.json');
			assert.equal(metadata.buildHash, buildHash, 'Pristine build mismatch');

			if (metadata.recipeHash !== recipeHash) {
				await record('bootstrap', { reason: 'configuration-mismatch' });
				await createDatabase?.();
				await bootstrap(cancellation);
				cancellation.throwIfAborted();
				complete = true;
				return;
			}

			const sql = await readFile(dump);
			assert.equal(snapshotHash(sql), metadata.dumpHash, 'Pristine dump digest mismatch');
			assert.equal(snapshotHash(metadata.snapshot), metadata.snapshotHash, 'Pristine inventory digest mismatch');
			operation = 'restore';
			await record('restoring');
			await command('import', sql);
			const snapshot = await snapshotInventory(database, id, cancellation, { vendor: runtime.vendor, deadline });
			if (snapshotHash(snapshot) !== metadata.snapshotHash)
				throw new Error('Restored database differs from pristine schema or data');
			await record('restored', { snapshotHash: metadata.snapshotHash });
		}

		cancellation.throwIfAborted();
		complete = true;
	} finally {
		await record('finished', { operation, complete, milliseconds: performance.now() - started });
	}
}
