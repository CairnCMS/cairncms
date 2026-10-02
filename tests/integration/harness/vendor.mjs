/* eslint-disable no-console */
import { createVitest } from 'vitest/node';
import { DefaultReporter, VerboseReporter } from 'vitest/reporters';
import { Wait } from 'testcontainers';
import { RecordedContainer } from './recorded-container.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { createWriteStream, writeFileSync } from 'node:fs';
import { LiveFailures } from './reporter.mjs';
import { validateSelection, accountExecution } from './results.mjs';
import { verifyPreparation } from './freshness.mjs';
import { databaseVendors } from './database-vendors.mjs';
import { exclusionReason } from './applicability.mjs';
import { nativeTestName } from './test-names.mjs';
import { snapshotVendors } from './snapshot.mjs';
import { createPristineStore, removePristineStore } from './pristine.mjs';

const options = JSON.parse(process.env.INTEGRATION_OPTIONS);
const { vendor, directory, collectAll, filters, pattern } = options;
const reports = `${directory}/${vendor}`;
await mkdir(reports, { recursive: true });
let vitest;
let container;
let infrastructureError;
let fileErrors = [];
let stopping = false;
let containerLog;
let containerStream;
let cancelled = false;
let cancellationCode;
let completed = false;

// The public wrapper owns OS signals. Sending SIGINT directly to Vitest invokes its
// immediate CLI exit listener, bypassing fixture teardown; IPC uses its graceful public API.
const cancel = (signal) => {
	cancelled = true;
	writeFileSync(`${reports}/cancelled`, signal);
	cancellationCode = signal === 'SIGINT' ? 130 : 143;
	process.exitCode = cancellationCode;
	void vitest?.cancelCurrentRun('keyboard-input');
};

const disconnected = () => cancel('SIGTERM');

process.on('message', (message) => {
	if (message?.type === 'cancel') cancel(message.signal);
});

process.once('disconnect', disconnected);

try {
	vitest = await createVitest('test', {
		root: fileURLToPath(new URL('../', import.meta.url)),
		config: options.configFile ?? fileURLToPath(new URL('../vitest.config.ts', import.meta.url)),
		bail: collectAll ? 0 : 1,
		fileParallelism: (options.workers ?? 1) > 1,
		maxWorkers: options.workers ?? 1,
		// Isolated workers are recycled after each file. Keep the configured capacity
		// so queued files can start while another worker is still busy.
		minWorkers: options.workers ?? 1,
		testNamePattern: pattern,
		reporters: [
			new LiveFailures(vendor, collectAll ? undefined : () => writeFileSync(`${reports}/cancelled`, 'test-failure')),
			options.verbose ? new VerboseReporter({ isTTY: false }) : new DefaultReporter({ isTTY: false }),
			'json',
			...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []),
		],
		outputFile: `${reports}/results.json`,
	});

	if (options.sequence) {
		Object.assign(vitest.config.sequence, options.sequence);

		for (const project of vitest.projects) {
			const { groupOrder } = project.config.sequence;
			Object.assign(project.config.sequence, options.sequence, { groupOrder });
		}
	}

	// Collection needs the same vendor identity as execution, without starting services.
	vitest.provide('integration', { vendor, directory: reports });

	const specs = await vitest.getRelevantTestSpecifications(filters);

	for (const filter of filters) {
		if (!(await vitest.getRelevantTestSpecifications([filter])).length)
			throw new Error(`No test file matches ${JSON.stringify(filter)}`);
	}

	if (!specs.length) throw new Error('No test files selected. Use a path relative to tests/integration.');
	const collected = await vitest.collectTests(specs);
	const tests = collected.testModules.flatMap((module) => [...module.children.allTests()]);
	const declarationErrors = tests.flatMap((test) => test.result().errors ?? []);
	if (declarationErrors.length)
		throw new Error(
			`Test declarations failed before provisioning: ${declarationErrors.map((error) => error.message).join('; ')}`
		);

	const matching = tests.filter((test) => !pattern || new RegExp(pattern).test(nativeTestName(test)));

	const runnable = [];
	const exclusions = [];

	for (const test of matching) {
		const reason = exclusionReason(test, vendor);

		if (test.options.mode !== 'run') {
			if (test.options.mode !== 'skip' || !reason)
				throw new Error(`Unexpected declared ${test.options.mode}: ${test.module.moduleId} > ${test.fullName}`);

			exclusions.push({
				id: test.id,
				file: test.module.moduleId,
				name: test.fullName,
				location: test.location,
				reason,
			});
		} else {
			if (test.options.retry || test.options.repeats || test.options.fails || test.options.concurrent)
				throw new Error(`Cases must run serially once, without retries or inverted failures: ${test.fullName}`);
			runnable.push(test);
		}
	}

	const importErrors = [...collected.unhandledErrors, ...collected.testModules.flatMap((module) => module.errors())];
	for (const error of importErrors) console.error(`[${vendor}] Collection failure: ${error.stack || error.message}`);
	if (importErrors.length) process.exitCode ||= 1;
	if (importErrors.length && !collectAll) throw new Error('Test collection failed; no services started.');
	if (!runnable.length && !exclusions.length)
		throw new Error('Selection contains no runnable tests. Check the file/name filter and skipped tests.');

	const selection = runnable.map((t) => ({
		id: t.id,
		file: t.module.moduleId,
		name: t.fullName,
		location: t.location,
	}));

	validateSelection(selection, true);
	validateSelection([...selection, ...exclusions]);
	await writeFile(`${reports}/exclusions.json`, JSON.stringify(exclusions, null, 2) + '\n');
	await writeFile(`${reports}/selection.json`, JSON.stringify(selection, null, 2) + '\n');

	console.log(`[${vendor}] Selected ${runnable.length} tests in ${specs.length} files`);
	for (const test of exclusions) console.log(`[${vendor}] EXCLUDED ${test.file} > ${test.name}: ${test.reason}`);
	if (options.ci && (!runnable.length || options.list))
		throw new Error('CI requires a nonzero runnable selection and actual test execution for every vendor.');

	if (options.list) {
		for (const test of runnable) console.log(`${vendor} ${test.module.moduleId} > ${test.fullName}`);
		completed = true;
	} else {
		const needsServices = options.services !== false && runnable.length > 0;

		const { artifacts, prepared } = needsServices
			? await verifyPreparation(fileURLToPath(new URL('../../../', import.meta.url)))
			: { artifacts: null, prepared: null };

		console.log(
			`[${vendor}] Using compiled api/dist; ${
				prepared
					? `prepared ${prepared.preparedAt} at ${prepared.revision}`
					: 'no compiled application required by this selection'
			}`
		);

		await writeFile(
			`${reports}/build.json`,
			JSON.stringify({ compiled: artifacts !== null, artifacts, prepared, node: process.version }, null, 2) + '\n'
		);

		if (cancelled) throw new Error('Cancelled before provisioning');
		let connection;

		if (vendor !== 'sqlite3' && needsServices) {
			const definition = databaseVendors[vendor];
			if (!definition?.image) throw new Error(`Unsupported vendor: ${vendor}`);
			console.log(`[${vendor}] Starting owned ${definition.version} engine`);

			containerLog = createWriteStream(`${reports}/database.log`);

			await writeFile(
				`${reports}/container.json`,
				JSON.stringify({
					image: definition.image,
					version: definition.version,
					owner: process.pid,
					run: basename(directory),
					vendor,
					state: 'starting',
				}) + '\n'
			);

			let engine = new RecordedContainer(definition.image, `${reports}/container.json`)
				.withLabels({ 'cairncms.integration.run': basename(directory), 'cairncms.integration.vendor': vendor })
				.withEnvironment(definition.environment)
				.withExposedPorts(definition.port)
				.withHealthCheck({
					test: definition.health,
					interval: 1_000,
					timeout: 1_000,
					retries: 60,
				})
				.withWaitStrategy(Wait.forAll([Wait.forHealthCheck(), Wait.forListeningPorts()]))
				.withStartupTimeout(90_000)
				.withLogConsumer((logs) => {
					containerStream = logs;
					containerStream.pipe(containerLog);
				});

			if (definition.command) engine = engine.withCommand(definition.command);
			container = await engine.start();

			connection = {
				host: container.getHost(),
				port: container.getMappedPort(definition.port),
				user: definition.user,
				password: 'integration',
			};

			await writeFile(
				`${reports}/container.json`,
				JSON.stringify({ id: container.getId(), image: definition.image, version: definition.version }) + '\n'
			);

			const engineLost = (error) => {
				if (stopping || infrastructureError) return;

				infrastructureError = `Database engine/log connection lost${
					error ? `: ${error.message}` : ''
				}; see ${reports}/database.log`;

				console.error(`[${vendor}] INFRASTRUCTURE FAILURE: ${infrastructureError}`);
				process.exitCode = 1;
				void vitest.cancelCurrentRun('test-failure');
			};

			containerStream.once('end', () => engineLost());
			containerStream.once('error', engineLost);
		}

		if (cancelled) throw new Error('Cancelled during provisioning');
		if (infrastructureError) throw new Error(infrastructureError);

		const pristine =
			snapshotVendors.includes(vendor) && needsServices
				? await createPristineStore(reports, {
						artifacts,
						prepared,
						node: process.version,
						image: databaseVendors[vendor].image,
				  })
				: undefined;

		vitest.provide('integration', { vendor, directory: reports, connection, pristine });
		const result = await vitest.start(filters);

		fileErrors = result.testModules
			.filter((module) => module.errors().length)
			.map((module) => ({ file: module.moduleId, errors: module.errors() }));

		if (result.unhandledErrors.length) fileErrors.push({ file: '(runner)', errors: result.unhandledErrors });
		const selected = new Set(selection.map((t) => t.id));

		const execution = result.testModules.flatMap((m) =>
			[...m.children.allTests()]
				.filter((t) => selected.has(t.id) || ['passed', 'failed'].includes(t.result().state))
				.map((t) => ({ id: t.id, file: m.moduleId, name: t.fullName, result: t.result(), meta: t.meta() }))
		);

		await writeFile(`${reports}/execution.json`, JSON.stringify(execution, null, 2) + '\n');
		if (!accountExecution(selection, execution).complete) process.exitCode ||= 1;
		completed = true;
		if (result.unhandledErrors.length || result.testModules.some((module) => module.state() === 'failed'))
			process.exitCode ||= 1;
	}
} catch (error) {
	infrastructureError = error.stack || String(error);
	console.error(`[${vendor}] INFRASTRUCTURE/SELECTION FAILURE: ${infrastructureError}`);
	process.exitCode ||= 1;
} finally {
	stopping = true;

	try {
		await vitest?.close();
	} catch (error) {
		infrastructureError ||= `Runner cleanup failed: ${error.stack || error}`;
		console.error(`[${vendor}] Runner cleanup failed`, error);
		process.exitCode ||= 1;
	}

	try {
		await removePristineStore(reports);
	} catch (error) {
		infrastructureError ||= `Pristine directory cleanup failed: ${error.message}`;
		console.error(`[${vendor}] Pristine directory cleanup failed`, error);
		process.exitCode ||= 1;
	}

	try {
		await container?.stop({ timeout: 10_000, removeVolumes: true });
	} catch (error) {
		infrastructureError ||= `Container cleanup failed: ${error.stack || error}`;
		console.error(`[${vendor}] Container cleanup failed; see ${reports}/container.json`, error);
		process.exitCode ||= 1;
	}

	containerStream?.destroy();
	containerLog?.end();
	if (infrastructureError) process.exitCode ||= 1;
	if (cancelled) process.exitCode = cancellationCode;

	await writeFile(
		`${reports}/outcome.json`,
		JSON.stringify(
			{ exitCode: process.exitCode || 0, completed, cancelled, infrastructureError, fileErrors },
			null,
			2
		) + '\n'
	);

	process.off('disconnect', disconnected);
	if (process.connected) process.disconnect();
}
