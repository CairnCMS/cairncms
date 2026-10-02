import { GenericContainer, getContainerRuntimeClient } from 'testcontainers';
import { readFile, writeFile } from 'node:fs/promises';

// Testcontainers can fail before it attaches the log consumer or returns an owned
// handle. Its creation hook records the exact ID before start/port readiness.
export class RecordedContainer extends GenericContainer {
	constructor(image, recordPath) {
		super(image);
		this.recordPath = recordPath;
	}

	async containerCreated(id) {
		this.ownedId = id;
		const record = JSON.parse(await readFile(this.recordPath, 'utf8'));
		await writeFile(this.recordPath, JSON.stringify({ ...record, id }) + '\n');
	}

	// Capture readiness errors before Testcontainers' wait helper removes the container.
	withWaitStrategy(strategy) {
		const recording = {
			waitUntilReady: async (container, ...args) => {
				try {
					await strategy.waitUntilReady(container, ...args);
				} catch (cause) {
					try {
						await this.captureStartupFailure(container, cause);
					} catch (error) {
						throw new AggregateError([cause, error], 'Container readiness and diagnostics failed');
					}

					throw cause;
				}
			},
			withStartupTimeout: (milliseconds) => {
				strategy.withStartupTimeout(milliseconds);
				return recording;
			},
			isStartupTimeoutSet: () => strategy.isStartupTimeoutSet(),
			getStartupTimeout: () => strategy.getStartupTimeout(),
		};

		return super.withWaitStrategy(recording);
	}

	async captureStartupFailure(container, cause) {
		if (this.startupCaptured) return;
		const client = await getContainerRuntimeClient();
		const info = await client.container.inspect(container);

		await writeFile(
			this.recordPath + '.startup.json',
			JSON.stringify({
				id: this.ownedId,
				error: String(cause),
				state: info.State,
				configuredPorts: info.HostConfig.PortBindings,
				actualPorts: info.NetworkSettings.Ports,
				networkMode: info.HostConfig.NetworkMode,
			}) + '\n'
		);

		await writeFile(
			this.recordPath + '.startup.docker-log',
			await container.logs({ follow: false, stdout: true, stderr: true })
		);

		this.startupCaptured = true;
	}

	async start() {
		try {
			return await super.start();
		} catch (cause) {
			if (!this.ownedId) throw cause;
			const errors = [cause];
			const client = await getContainerRuntimeClient();
			const owned = client.container.getById(this.ownedId);

			try {
				await this.captureStartupFailure(owned, cause);
			} catch (error) {
				// A wait strategy may already have removed the failed container.
				if (error.statusCode !== 404) errors.push(error);
			} finally {
				try {
					await owned.remove({ force: true, v: true });
				} catch (error) {
					if (error.statusCode !== 404) errors.push(error);
				}
			}

			if (errors.length > 1) throw new AggregateError(errors, 'Container startup and diagnostics/cleanup failed');
			throw cause;
		}
	}
}
