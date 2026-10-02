import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import { Wait } from 'testcontainers';
import { RecordedContainer } from './recorded-container.mjs';
import { databaseVendors } from './database-vendors.mjs';
import { dropDatabase } from '../fixtures/drop-database.mjs';

async function withLockedDatabase(use) {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-database-cleanup-'));
	const definition = databaseVendors.mysql5;
	const name = `test_${randomUUID().replaceAll('-', '')}`;
	let container;
	let admin;
	let reader;
	let transaction;
	let failure;

	try {
		const record = join(directory, 'container.json');
		await writeFile(record, JSON.stringify({ image: definition.image }));

		container = await new RecordedContainer(definition.image, record)
			.withEnvironment(definition.environment)
			.withCommand(definition.command)
			.withExposedPorts(definition.port)
			.withHealthCheck({ test: definition.health, interval: 1000, timeout: 1000, retries: 60 })
			.withWaitStrategy(Wait.forAll([Wait.forHealthCheck(), Wait.forListeningPorts()]))
			.withStartupTimeout(90_000)
			.start();

		const configuration = {
			client: 'mysql2',
			connection: {
				host: container.getHost(),
				port: container.getMappedPort(definition.port),
				user: definition.user,
				password: definition.environment.MYSQL_ROOT_PASSWORD,
				connectTimeout: 10_000,
			},
			pool: { min: 0, max: 1 },
			acquireConnectionTimeout: 10_000,
		};

		admin = knex(configuration);
		reader = knex(configuration);
		await admin.raw('CREATE DATABASE ??', [name]).timeout(10_000);
		await admin.raw('CREATE TABLE ??.marker (id INT PRIMARY KEY) ENGINE=InnoDB', [name]).timeout(10_000);
		await admin.raw('INSERT INTO ??.marker VALUES (1)', [name]).timeout(10_000);
		transaction = await reader.transaction();
		await transaction.raw('SELECT * FROM ??.marker', [name]).timeout(10_000);
		await use({ admin, name, release: () => transaction.commit() });
	} catch (error) {
		failure = error;
	} finally {
		const cleanup = [];

		if (transaction && !transaction.isCompleted()) {
			try {
				await transaction.rollback();
			} catch (error) {
				cleanup.push(error);
			}
		}

		for (const result of await Promise.allSettled([reader?.destroy(), admin?.destroy()])) {
			if (result.status === 'rejected') cleanup.push(result.reason);
		}

		try {
			await container?.stop();
		} catch (error) {
			cleanup.push(error);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}

		if (cleanup.length)
			failure = new AggregateError([...(failure ? [failure] : []), ...cleanup], 'Database control cleanup failed');
	}

	if (failure) throw failure;
}

test(
	'database deletion can finish beyond the ordinary administrative query deadline',
	{ timeout: 150_000 },
	async () => {
		await withLockedDatabase(async ({ admin, name, release }) => {
			let timer;

			const unlock = new Promise((resolve, reject) => {
				timer = setTimeout(() => release().then(resolve, reject), 12_000);
			});

			try {
				await Promise.all([dropDatabase(admin, name, 'mysql5'), unlock]);

				const [remaining] = await admin.raw(
					'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
					[name]
				);

				assert.equal(remaining.length, 0);
			} finally {
				clearTimeout(timer);
			}
		});
	}
);

test('blocked database deletion still fails at its own deadline', { timeout: 180_000 }, async () => {
	await withLockedDatabase(async ({ admin, name }) => {
		await assert.rejects(dropDatabase(admin, name, 'mysql5'), (error) => {
			assert.equal(error.name, 'KnexTimeoutError');
			assert.equal(error.timeout, 60_000);
			return true;
		});
	});
});
