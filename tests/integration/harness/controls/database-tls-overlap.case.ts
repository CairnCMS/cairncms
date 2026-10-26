import { expect, inject } from 'vitest';
import { access } from 'node:fs/promises';
import { withDatabaseTls } from '../../fixtures/database-tls';
import { createEnvironmentTest, withEnvironment } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { initializeFixtures } from '../fixture-setup.mjs';
import request from '../../fixtures/request';

initializeFixtures();

const test = createEnvironmentTest().extend<{ proof: Prerequisite<void> }>({
	proof: [
		async ({ cancellationSignal, teardownFailures }, use) => {
			const runtime = inject('integration');

			await capturePrerequisite<void>(
				(ready) =>
					withEnvironment(
						runtime,
						false,
						async (ordinary) => {
							const pristine = runtime.pristine!.directory;
							await access(pristine);

							await withDatabaseTls(runtime, cancellationSignal, async (first) => {
								await withEnvironment(
									runtime,
									false,
									async (firstApi) => {
										await firstApi.database.schema.createTable('tls_marker', (table) => table.string('value'));
										await firstApi.database('tls_marker').insert({ value: 'first' });

										await withDatabaseTls(runtime, cancellationSignal, async (second) => {
											await withEnvironment(
												runtime,
												false,
												async (secondApi) => {
													const firstConnection = firstApi.database.client.config.connection;
													const secondConnection = secondApi.database.client.config.connection;
													expect(firstConnection.port).not.toBe(secondConnection.port);
													expect(firstConnection.database).not.toBe(secondConnection.database);
													expect(firstConnection.port).not.toBe(runtime.connection!.port);
													expect(await secondApi.database.schema.hasTable('tls_marker')).toBe(false);
													await secondApi.database.schema.createTable('tls_marker', (table) => table.string('value'));
													await secondApi.database('tls_marker').insert({ value: 'second' });
													expect(await firstApi.database('tls_marker').first('value')).toEqual({ value: 'first' });
													expect(await secondApi.database('tls_marker').first('value')).toEqual({ value: 'second' });
													await ready();
												},
												cancellationSignal,
												{ databaseTls: second }
											);
										});

										// The outer API must keep its connection and data after its neighbor is destroyed.
										expect(await firstApi.database('tls_marker').first('value')).toEqual({ value: 'first' });
										expect((await first.probe()).ok).toBe(true);
									},
									cancellationSignal,
									{ databaseTls: first }
								);
							});

							await access(pristine);
							await request(ordinary.url).get('/server/ping').expect(200);
							expect(await ordinary.database.schema.hasTable('tls_marker')).toBe(false);
							expect(ordinary.database.client.config.connection.ssl).toBeUndefined();
							await expect(ordinary.start({ DB_SSL__REJECT_UNAUTHORIZED: 'false' })).rejects.toThrow('owns DB_');

							await withEnvironment(
								runtime,
								false,
								async (restored) => {
									await request(restored.url).get('/server/ping').expect(200);
								},
								cancellationSignal
							);
						},
						cancellationSignal
					),
				use,
				teardownFailures
			);
		},
		{ scope: 'file', auto: true },
	],
});

test('TLS environments coexist without borrowing or destroying ordinary resources', async ({ proof, task, skip }) => {
	requirePrerequisite(proof, 'TLS isolation', { task, skip });
});
