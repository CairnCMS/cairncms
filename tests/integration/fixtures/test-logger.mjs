import { StringDecoder } from 'node:string_decoder';

export class TestLogger {
	/**
	 * Capture complete stdout lines until the request marker and optional completion condition are satisfied.
	 * @param {import('node:child_process').ChildProcess} server
	 * @param {string} stopCondition
	 * @param {boolean | string} [filterCondition]
	 * @param {{ timeoutMs?: number, completeWhen?: (logs: string) => boolean }} [options]
	 */
	constructor(server, stopCondition, filterCondition, options = {}) {
		this.server = server;
		this.stopCondition = stopCondition;
		this.markerSeen = false;
		this.completeWhen = options.completeWhen;
		this.filterCondition = filterCondition === true ? stopCondition : filterCondition || undefined;
		this.logs = '';
		this.buffer = '';
		this.decoder = new StringDecoder('utf8');
		this.stopped = false;
		/** @type {Error | undefined} */
		this.failure = undefined;
		/** @type {((logs: string) => void) | undefined} */
		this.resolve = undefined;
		/** @type {((error: Error) => void) | undefined} */
		this.reject = undefined;

		this.timer = setTimeout(
			() => this.fail(new Error(`Log capture for ${stopCondition} did not complete before the deadline`)),
			options.timeoutMs ?? 10_000
		);

		server.stdout?.on('data', this.processChunks);
		server.once('exit', this.onExit);
		server.once('error', this.onError);
	}

	/** @param {Buffer | string} chunk */
	processChunks = (chunk) => {
		this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
		let newline;

		while (!this.stopped && (newline = this.buffer.indexOf('\n')) !== -1) {
			const line = this.buffer.slice(0, newline + 1);
			this.buffer = this.buffer.slice(newline + 1);
			if (!this.filterCondition || line.includes(this.filterCondition)) this.logs += line;

			this.markerSeen ||= line.includes(this.stopCondition);

			try {
				// Application and HTTP loggers can flush their records in either order.
				if (this.markerSeen && (!this.completeWhen || this.completeWhen(this.logs))) {
					this.stopped = true;
					this.cleanup();
					this.resolve?.(this.logs);
				}
			} catch (error) {
				this.fail(error);
			}
		}
	};

	onExit = () => this.fail(new Error(`API exited before log capture for ${this.stopCondition} completed`));
	/** @param {Error} error */
	onError = (error) => this.fail(error);
	/** @param {Error} error */
	fail(error) {
		if (this.stopped) return;
		this.stopped = true;
		this.failure = error;
		this.cleanup();
		this.reject?.(error);
	}

	/** @returns {Promise<string>} */
	getLogs = () => {
		if (this.failure) return Promise.reject(this.failure);
		if (this.stopped) return Promise.resolve(this.logs);
		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	};

	cleanup = () => {
		clearTimeout(this.timer);
		this.server.stdout?.off('data', this.processChunks);
		this.server.off('exit', this.onExit);
		this.server.off('error', this.onError);
	};
}
