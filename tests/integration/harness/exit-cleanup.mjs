import { readdir, readFile, lstat, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { removePristineStore } from './pristine.mjs';
import { removeMarkedDirectory } from './owned-directory.mjs';

export async function removeOwnedDirectories(reports) {
	const removed = [];
	const errors = [];

	const files = await readdir(reports).catch((error) => {
		if (error.code === 'ENOENT') return [];
		throw error;
	});

	for (const file of files.filter((name) => /^test_[a-f0-9]{32}\.owner\.json$/.test(name))) {
		try {
			const owner = JSON.parse(await readFile(join(reports, file), 'utf8'));
			const id = file.slice(0, -'.owner.json'.length);
			if (
				typeof owner.directory !== 'string' ||
				dirname(resolve(owner.directory)) !== resolve(tmpdir()) ||
				!basename(owner.directory).startsWith('cairn-integration-') ||
				owner.database !== id
			)
				throw new Error(`Invalid owned directory record: ${file}`);

			const info = await lstat(owner.directory).catch((error) => {
				if (error.code === 'ENOENT') return undefined;
				throw error;
			});

			if (!info) continue;
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe owned directory: ${file}`);

			const marker = await readFile(join(owner.directory, '.integration-owner.json'), 'utf8').catch((error) => {
				if (error.code === 'ENOENT') return undefined;
				throw error;
			});

			if (marker === undefined) {
				// A crash after unlinking the marker leaves only the final empty directory.
				await rmdir(owner.directory).catch((error) => {
					if (error.code !== 'ENOENT') throw error;
				});
			} else {
				const identity = JSON.parse(marker);
				if (identity.id !== id || identity.reports !== reports)
					throw new Error(`Directory ownership mismatch: ${file}`);
				await removeMarkedDirectory(owner.directory);
			}

			removed.push(owner.directory);
		} catch (error) {
			errors.push(String(error));
		}
	}

	return { removed, errors };
}

export async function cleanupAfterExit(reports, pid) {
	const record = { processesStopped: false, containersRemoved: [], directoriesRemoved: [], errors: [] };

	const signalGroup = (signal) => {
		try {
			process.kill(-pid, signal);
			return true;
		} catch (error) {
			if (error.code === 'ESRCH') return false;
			throw error;
		}
	};

	try {
		// The vendor is spawned as its own process group. Its worker finally blocks
		// cannot run after an abrupt runner exit; stop descendants before deleting data.
		if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 1)) throw new Error('Invalid vendor process ID');

		if (pid && signalGroup('SIGTERM')) {
			const deadline = performance.now() + 5000;
			while (signalGroup(0) && performance.now() < deadline) await delay(50);
			if (signalGroup('SIGKILL')) await delay(100);
		}

		record.processesStopped = true;
	} catch (error) {
		record.errors.push(`Process cleanup: ${error}`);
	}

	try {
		const files = await readdir(reports);

		if (files.some((file) => file === 'container.json' || file.endsWith('.service.json'))) {
			const { getContainerRuntimeClient } = await import('testcontainers');
			const client = await getContainerRuntimeClient();
			const run = basename(dirname(reports));

			const containers = await client.container.dockerode.listContainers({
				all: true,
				abortSignal: AbortSignal.timeout(10_000),
				filters: { label: [`cairncms.integration.run=${run}`] },
			});

			for (const container of containers) {
				if (container.Labels['cairncms.integration.run'] !== run) throw new Error('Container ownership mismatch');

				try {
					await client.container.getById(container.Id).remove({
						force: true,
						v: true,
						abortSignal: AbortSignal.timeout(10_000),
					});

					record.containersRemoved.push(container.Id);
				} catch (error) {
					if (error.statusCode !== 404) record.errors.push(`Container cleanup: ${error}`);
				}
			}
		}
	} catch (error) {
		if (error.code !== 'ENOENT') record.errors.push(`Container cleanup: ${error}`);
	}

	if (record.processesStopped) {
		try {
			await removePristineStore(reports);
		} catch (error) {
			record.errors.push(`Pristine directory cleanup: ${error.message}`);
		}

		const directories = await removeOwnedDirectories(reports);
		record.directoriesRemoved = directories.removed;
		record.errors.push(...directories.errors);
	}

	return record;
}
