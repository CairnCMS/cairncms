import { test, expect, inject } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withEnvironment } from '../../fixtures/environment';
import { withStorage } from '../../fixtures/storage';
import { snapshotInventory } from '../snapshot.mjs';
import { initializeFixtures } from '../fixture-setup.mjs';
import { canonicalFresh } from './pristine-support';
import { runtimeConfigurations } from './runtime-configurations.mjs';

initializeFixtures();

async function compare(env: Record<string, string>, signal: AbortSignal) {
	const runtime = inject('integration');
	const inventories: string[] = [];
	const ids: string[] = [];

	for (const options of [{ env }, { env, bootstrap: 'fresh' as const }, {}, { env }]) {
		await withEnvironment(
			runtime,
			false,
			async (api) => {
				const id = api.database.client.config.connection.database ?? api.database.client.config.connection.filename;

				ids.push(
					runtime.vendor === 'sqlite3'
						? JSON.parse(await readFile(join(api.directory, '.integration-owner.json'), 'utf8')).id
						: id
				);

				inventories.push(canonicalFresh(await snapshotInventory(api.database, id, signal, { vendor: runtime.vendor })));
			},
			signal,
			options
		);
	}

	expect(new Set(inventories).size).toBe(1);
	expect(new Set(ids).size).toBe(4);

	const events = (await readFile(join(runtime.directory, 'provisioning.jsonl'), 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));

	expect(events.find((event) => event.id === ids[1] && event.type === 'finished')?.operation).toBe('bootstrap');
	expect(events.find((event) => event.id === ids[2] && event.type === 'finished')?.operation).toBe('restore');
	expect(events.find((event) => event.id === ids[3] && event.type === 'finished')?.operation).toBe('restore');
	expect(events.some((event) => event.id === ids[0] && event.reason === 'configuration-mismatch')).toBe(false);
}

test('runtime cache settings preserve fresh database contents', async ({ signal }) => {
	await compare(runtimeConfigurations.cache.env, signal);
}, 180000);

test('runtime file limits preserve fresh database contents', async ({ signal }) => {
	await compare(runtimeConfigurations.files.env, signal);
}, 180000);

test('runtime storage settings preserve fresh database contents', async ({ signal }) => {
	await withStorage(inject('integration').directory, signal, async (storage) => {
		expect(Object.keys(storage.env).sort()).toEqual([...runtimeConfigurations.storage.keys].sort());
		await compare(storage.env, signal);
	});
}, 180000);
