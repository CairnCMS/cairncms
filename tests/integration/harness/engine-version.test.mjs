import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseVendors, familyOf, vendors } from './database-vendors.mjs';
import { engineCommand, probeSignal, recordEngine, sqliteEngine } from './engine-version.mjs';

let directory;

const fakeDocker = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DOCKER_ARGS"
case "$FAKE_DOCKER_MODE" in
	version)
		echo '8.4.13'
		echo 'mysql: [Warning] Using a password on the command line interface can be insecure.' >&2
		;;
	denied)
		echo 'ERROR 1045 (28000): Access denied for user' >&2
		exit 1
		;;
	empty) ;;
	stall) exec sleep 60 ;;
esac
`;

before(async () => {
	directory = await mkdtemp(join(tmpdir(), 'cairn-engine-version-'));
	await writeFile(join(directory, 'docker'), fakeDocker, { mode: 0o755 });
	process.env.PATH = `${directory}:${process.env.PATH}`;
	process.env.FAKE_DOCKER_ARGS = join(directory, 'args');
});

after(() => rm(directory, { recursive: true, force: true }));

const probe = async (mode, options = {}) => {
	process.env.FAKE_DOCKER_MODE = mode;
	await rm(process.env.FAKE_DOCKER_ARGS, { force: true });
	const events = [];
	const errors = [];

	const result = recordEngine({
		id: 'container-id',
		definition: databaseVendors.mysql84,
		signal: probeSignal(new AbortController().signal),
		record: async (type, detail) => {
			events.push({ type, ...detail });
		},
		stderr: (chunk) => errors.push(chunk),
		...options,
	});

	return { result, events, stderr: () => Buffer.concat(errors).toString() };
};

test('each server family reads its version with complete connection parameters', () => {
	for (const vendor of vendors.filter((vendor) => databaseVendors[vendor].image)) {
		const command = engineCommand(databaseVendors[vendor]);
		assert(command.includes('--host=127.0.0.1'), vendor);

		if (familyOf(vendor) === 'postgres') {
			assert.equal(command[0], 'psql');
			assert(command.includes('--username=integration'), vendor);
			assert(command.includes('--dbname=postgres'), vendor);
			assert(command.includes('--command=select version()'), vendor);
		} else {
			assert.equal(command[0], familyOf(vendor) === 'maria' ? 'mariadb' : 'mysql');
			assert(command.includes('--user=root'), vendor);
			assert(command.includes('--password=integration'), vendor);
			assert(command.includes('--execute=select version()'), vendor);
		}
	}

	assert.throws(() => engineCommand(databaseVendors.sqlite3), /No engine command for the sqlite family/);
});

test('stdout is the version and stderr goes only to the sink', async () => {
	const { result, events, stderr } = await probe('version');
	assert.equal(await result, '8.4.13');
	assert.match(stderr(), /Using a password on the command line/);

	assert.deepEqual((await readFile(process.env.FAKE_DOCKER_ARGS, 'utf8')).trim().split('\n'), [
		'exec',
		'container-id',
		...engineCommand(databaseVendors.mysql84),
	]);

	assert.deepEqual(
		events.map((event) => [event.type, event.operation]),
		[
			['tool-started', 'engine-version'],
			['tool-closed', 'engine-version'],
		]
	);
});

test('a failed client fails the probe with its stderr', async () => {
	const { result } = await probe('denied');
	await assert.rejects(result, /Engine version probe failed: .*exit=1.*Access denied/s);
});

test('empty stdout fails the probe', async () => {
	const { result } = await probe('empty');
	await assert.rejects(result, /Engine version probe returned no version/);
});

test('an aborted run fails the probe before starting the client', async () => {
	const controller = new AbortController();
	controller.abort();
	const { result, events } = await probe('version', { signal: probeSignal(controller.signal) });
	await assert.rejects(result, /Engine version probe was cancelled/);
	assert.deepEqual(events, []);
	await assert.rejects(readFile(process.env.FAKE_DOCKER_ARGS), { code: 'ENOENT' });
});

test('a stalled client ends on the probe deadline', async () => {
	const started = performance.now();
	const { result, events } = await probe('stall', { signal: probeSignal(new AbortController().signal, 200) });
	await assert.rejects(result, /Engine version probe exceeded its deadline: .*cancelled=true/s);
	assert(performance.now() - started < 5_000);
	const pid = events.find((event) => event.type === 'tool-started').pid;
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('cancellation ends a stalled client before its deadline', async () => {
	const controller = new AbortController();
	const started = performance.now();
	const { result } = await probe('stall', { signal: probeSignal(controller.signal, 60_000) });
	setTimeout(() => controller.abort(), 200);
	await assert.rejects(result, /Engine version probe was cancelled: .*cancelled=true/s);
	assert(performance.now() - started < 5_000);
});

test('the SQLite version comes from the bundled driver', async () => {
	assert.match(await sqliteEngine(), /^3\.\d+\.\d+$/);
});
