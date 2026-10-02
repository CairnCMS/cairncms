import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	canRestore,
	createPristineStore,
	initializeDatabase,
	removePristineStore,
	runtimeSettings,
} from './pristine.mjs';
import { snapshotHash } from './snapshot.mjs';
import { runtimeConfigurations } from './controls/runtime-configurations.mjs';

test('every eligible runtime setting belongs to a justified equivalence configuration', () => {
	const covered = Object.values(runtimeConfigurations).flatMap((configuration) => {
		assert.equal(typeof configuration.reason, 'string');
		assert(configuration.reason.trim().length > 0);
		return configuration.keys ?? Object.keys(configuration.env);
	});

	assert.equal(new Set(covered).size, covered.length, 'Configuration keys must have one equivalence owner');
	assert.deepEqual([...runtimeSettings].sort(), covered.sort());
});

test('restoration excludes other vendors and bootstrap-dependent environments', () => {
	const runtime = { vendor: 'mysql', pristine: { directory: '/owned' } };
	for (const vendor of ['mysql', 'mysql5', 'maria', 'postgres', 'postgres10', 'sqlite3'])
		assert.equal(canRestore({ ...runtime, vendor }, {}), true);
	assert.equal(canRestore(runtime, { hooks: true }), true);

	assert.equal(
		canRestore(runtime, { env: { CACHE_SCHEMA: 'false', CACHE_ENABLED: 'true', CACHE_STORE: 'memory' } }),
		true
	);

	assert.equal(
		canRestore(runtime, { env: { FILES_MAX_UPLOAD_SIZE: '1mb', FILES_MIME_TYPE_ALLOW_LIST: 'image/png' } }),
		true
	);

	assert.equal(canRestore(runtime, { env: { STORAGE_LOCATIONS: 'local,s3', STORAGE_S3_BUCKET: 'owned' } }), true);
	for (const options of [
		{ bootstrap: 'fresh' },
		{ env: { PROJECT_NAME: 'configured' } },
		{ env: { CACHE_SCHEMA: 'false', PROJECT_NAME: 'configured' } },
		{ env: { CACHE_STORE: 'redis' } },
		{ env: { FUTURE_SETTING: 'configured' } },
		{ origin: {} },
		{ absoluteOrigin: true },
		{ extensions: ['custom'] },
		{ migrations: ['custom.cjs'] },
	])
		assert.equal(canRestore(runtime, options), false);
	for (const vendor of ['unknown']) assert.equal(canRestore({ ...runtime, vendor }, {}), false);
	assert.equal(canRestore({ vendor: 'mysql' }, {}), false);
});

for (const mode of ['owned', 'empty-unmarked', 'nonempty-unmarked', 'wrong-marker', 'symlink', 'different-report']) {
	test(`pristine cleanup respects directory ownership: ${mode}`, async (context) => {
		const reports = await mkdtemp(join(tmpdir(), 'pristine-reports-'));
		const store = await createPristineStore(reports, { build: 'one' });
		const unrelated = await mkdtemp(join(tmpdir(), 'unrelated-'));

		context.after(async () => {
			await rm(store.directory, { recursive: true, force: true });
			await rm(unrelated, { recursive: true, force: true });
			await rm(reports, { recursive: true, force: true });
		});

		assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
		if (mode.includes('unmarked')) await rm(join(store.directory, '.integration-owner.json'));
		if (mode === 'nonempty-unmarked') await writeFile(join(store.directory, 'unowned.txt'), 'retain');
		if (mode === 'wrong-marker') await writeFile(join(store.directory, '.integration-owner.json'), '{}');

		if (mode === 'different-report') {
			const path = join(reports, 'pristine.json');
			const record = JSON.parse(await readFile(path, 'utf8'));
			await writeFile(path, JSON.stringify({ ...record, reports: unrelated }));
		}

		if (mode === 'symlink') {
			await rm(store.directory, { recursive: true });
			await writeFile(join(unrelated, 'retain.txt'), 'retain');
			await symlink(unrelated, store.directory);
		}

		if (['owned', 'empty-unmarked'].includes(mode)) {
			await removePristineStore(reports);
			await assert.rejects(access(store.directory), { code: 'ENOENT' });
			await removePristineStore(reports);
		} else {
			await assert.rejects(removePristineStore(reports));
			await access(store.directory);
			if (mode === 'symlink') assert.equal(await readFile(join(unrelated, 'retain.txt'), 'utf8'), 'retain');
		}
	});
}

test('template identity binds build and engine while invocation directories remain distinct', async (context) => {
	const reports = await Promise.all([1, 2, 3].map(() => mkdtemp(join(tmpdir(), 'pristine-reports-'))));

	context.after(async () => {
		for (const path of reports) {
			await removePristineStore(path);
			await rm(path, { recursive: true });
		}
	});

	const stores = await Promise.all(
		reports.map((path, index) =>
			createPristineStore(path, { build: 'one', engine: index === 2 ? 'different' : 'same' })
		)
	);

	assert.equal(new Set(stores.map((store) => store.directory)).size, 3);
	assert.equal(stores[0].buildHash, stores[1].buildHash);
	assert.notEqual(stores[0].buildHash, stores[2].buildHash);
});

for (const field of ['buildHash', 'recipeHash', 'dumpHash', 'snapshotHash']) {
	test(`invalid template hash ${field} rejects before bootstrapping`, async (context) => {
		const reports = await mkdtemp(join(tmpdir(), 'pristine-metadata-'));
		const pristine = await createPristineStore(reports, { build: 'control' });

		context.after(async () => {
			await removePristineStore(reports);
			await rm(reports, { recursive: true });
		});

		const extensions = join(reports, 'extensions');
		await mkdir(extensions);
		await mkdir(join(pristine.directory, 'claim'));
		await writeFile(join(reports, 'container.json'), JSON.stringify({ id: 'unused' }));
		const sql = Buffer.from('-- unused');
		await writeFile(join(pristine.directory, 'pristine.snapshot'), sql, { mode: 0o600 });

		await writeFile(
			join(pristine.directory, 'ready.json'),
			JSON.stringify({
				buildHash: pristine.buildHash,
				recipeHash: snapshotHash({}),
				dumpHash: snapshotHash(sql),
				snapshotHash: snapshotHash({}),
				snapshot: {},
				[field]: 'invalid-template-value',
			}),
			{ mode: 0o600 }
		);

		let bootstrapped = false;

		await assert.rejects(
			initializeDatabase({
				runtime: { vendor: 'mysql', directory: reports, pristine },
				id: 'unused',
				env: { EXTENSIONS_PATH: extensions },
				database: {},
				bootstrap: async () => {
					bootstrapped = true;
					throw new Error('Unexpected bootstrap');
				},
				signal: new AbortController().signal,
				options: {},
			}),
			(error) => {
				assert.match(error.message, /Invalid pristine metadata/);
				return true;
			}
		);

		assert.equal(bootstrapped, false);
	});
}
