type Waiter<T> = {
	resolve: (result: IteratorResult<T, void>) => void;
	reject: (error: unknown) => void;
};

type Entry<T> = { frame: T; bytes: number };

type Terminal = { kind: 'closed' } | { kind: 'failed'; error: unknown };

/** Owns one subscription's queued frames, pending pulls, and terminal state. */
export class Channel<T = Record<string, any>> {
	private queue: Entry<T>[] = [];
	private waiters: Waiter<T>[] = [];
	private terminal: Terminal | null = null;

	constructor(private readonly release: (bytes: number) => void) {}

	tryHandoff(frame: T): boolean {
		if (this.terminal !== null) return true;

		const waiter = this.waiters.shift();
		if (waiter === undefined) return false;

		waiter.resolve({ value: frame, done: false });
		return true;
	}

	enqueue(frame: T, bytes: number): void {
		if (this.terminal !== null) return;
		this.queue.push({ frame, bytes });
	}

	next(): Promise<IteratorResult<T, void>> {
		const entry = this.queue.shift();

		if (entry !== undefined) {
			this.release(entry.bytes);
			return Promise.resolve({ value: entry.frame, done: false });
		}

		if (this.terminal !== null) {
			return this.terminal.kind === 'failed'
				? Promise.reject(this.terminal.error)
				: Promise.resolve({ value: undefined, done: true });
		}

		return new Promise<IteratorResult<T, void>>((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	close(): void {
		if (this.terminal !== null) return;
		this.terminal = { kind: 'closed' };
		this.releaseQueue();

		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter.resolve({ value: undefined, done: true });
	}

	fail(error: unknown): void {
		if (this.terminal !== null) return;
		this.terminal = { kind: 'failed', error };
		this.releaseQueue();

		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter.reject(error);
	}

	private releaseQueue(): void {
		for (const entry of this.queue) this.release(entry.bytes);
		this.queue = [];
	}
}
