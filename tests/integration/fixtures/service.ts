/* eslint-disable no-console */
import { Wait, type StartedTestContainer, type WaitStrategy } from 'testcontainers';
import { createWriteStream } from 'node:fs';
import { RecordedContainer } from '../harness/recorded-container.mjs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import type { Readable } from 'node:stream';

export type ServiceDefinition = {
	name: string;
	image: string;
	port: number;
	environment?: Record<string, string>;
	wait?: WaitStrategy;
	startupTimeoutMs?: number;
};

export async function withService<T>(
	definition: ServiceDefinition,
	directory: string,
	signal: AbortSignal,
	use: (service: {
		container: StartedTestContainer;
		host: string;
		port: number;
		available: () => boolean;
	}) => Promise<T>
): Promise<T> {
	signal.throwIfAborted();
	const id = `${definition.name}-${randomUUID()}`;
	const ownerPath = join(directory, `${id}.service.json`);
	const log = createWriteStream(join(directory, `${id}.log`));
	let stream: Readable | undefined;
	let container: StartedTestContainer | undefined;
	let closing = false;
	let lost: Error | undefined;
	let stopPromise: Promise<unknown> | undefined;
	const errors: unknown[] = [];
	let value: T | undefined;

	const stop = () => {
		closing = true;
		return (stopPromise ??= container?.stop({ timeout: 10_000, removeVolumes: true }));
	};

	const abort = () => {
		void stop()?.catch((error) => errors.push(error));
	};

	try {
		console.log(`Starting owned ${definition.name} service`);

		const run = basename(dirname(directory));

		await writeFile(
			ownerPath,
			JSON.stringify({ serviceKey: id, run, image: definition.image, owner: process.pid, state: 'starting' }) + '\n'
		);

		container = await new RecordedContainer(definition.image, ownerPath)
			.withLabels({ 'cairncms.integration.service': id, 'cairncms.integration.run': run })
			.withEnvironment(definition.environment ?? {})
			.withExposedPorts(definition.port)
			.withWaitStrategy(definition.wait ?? Wait.forListeningPorts())
			.withStartupTimeout(definition.startupTimeoutMs ?? 60_000)
			.withLogConsumer((logs) => {
				stream = logs;
				stream.pipe(log);
			})
			.start();

		await writeFile(
			ownerPath,
			JSON.stringify({
				id: container.getId(),
				serviceKey: id,
				run,
				image: definition.image,
				owner: process.pid,
				state: 'ready',
			}) + '\n'
		);

		signal.addEventListener('abort', abort, { once: true });
		signal.throwIfAborted();

		const onLoss = (error?: Error) => {
			if (closing) return;
			lost ??= new Error(`${definition.name} service/log connection lost${error ? `: ${error.message}` : ''}`);
			console.error(lost.message);
		};

		stream!.once('end', () => onLoss());
		stream!.once('error', onLoss);

		value = await use({
			container,
			host: container.getHost(),
			port: container.getMappedPort(definition.port),
			available: () => !lost && !closing,
		});
	} catch (error) {
		errors.push(error);
	} finally {
		signal.removeEventListener('abort', abort);
		if (lost) errors.push(lost);

		try {
			await stop();
			if (container)
				await writeFile(
					ownerPath,
					JSON.stringify({ id: container.getId(), serviceKey: id, image: definition.image, removed: true }) + '\n'
				);
		} catch (error) {
			errors.push(error);
		}

		stream?.destroy();
		log.end();
	}

	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, `${definition.name} fixture failed`);
	return value!;
}
