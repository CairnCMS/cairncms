type DeliverFrame = (frame: string) => Promise<void>;

interface Generation {
	readonly settled: Promise<void>;
	settledFlag: boolean;
	completed: boolean;
}

interface OperationLane {
	tail: Promise<void>;
	pending: number;
	current: Generation | null;
}

export class OperationSequencer {
	private readonly lanes = new Map<string, OperationLane>();
	private stopped = false;
	private resolveStop!: () => void;
	private readonly stopSignal = new Promise<void>((resolve) => {
		this.resolveStop = resolve;
	});

	constructor(private readonly deliver: DeliverFrame, private readonly track: (work: Promise<unknown>) => void) {}

	get size(): number {
		return this.lanes.size;
	}

	cancel(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.resolveStop();
	}

	route(id: string, type: 'subscribe' | 'complete', frame: string): void {
		if (type === 'complete') {
			this.routeComplete(id, frame);
		} else {
			this.routeSubscribe(id, frame);
		}
	}

	private routeSubscribe(id: string, frame: string): void {
		const lane = this.lanes.get(id) ?? { tail: Promise.resolve(), pending: 0, current: null };
		this.lanes.set(id, lane);

		const priorTail = lane.tail;
		const predecessor = lane.current !== null && !lane.current.settledFlag ? lane.current : null;
		const reuse = predecessor !== null && predecessor.completed;
		const duplicate = predecessor !== null && !predecessor.completed;

		lane.pending++;

		let markStarted!: () => void;

		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});

		lane.tail = started;

		let generation: Generation | null = null;
		let markSettled: (() => void) | null = null;

		if (!duplicate) {
			let resolveSettled!: () => void;

			const settled = new Promise<void>((resolve) => {
				resolveSettled = resolve;
			});

			generation = { settled, settledFlag: false, completed: false };
			markSettled = resolveSettled;
			lane.current = generation;
		}

		const step = (async () => {
			await Promise.race([priorTail, this.stopSignal]);
			if (reuse && predecessor !== null) await Promise.race([predecessor.settled, this.stopSignal]);

			if (this.stopped) {
				this.settleStart(lane, id, markStarted);
				if (generation !== null && markSettled !== null) this.settleGeneration(lane, id, generation, markSettled);
				return;
			}

			const lifetime = this.deliver(frame);
			this.track(lifetime);
			this.settleStart(lane, id, markStarted);

			if (generation !== null && markSettled !== null) {
				const boundGeneration = generation;
				const boundSettle = markSettled;

				void lifetime
					.catch(() => undefined)
					.finally(() => this.settleGeneration(lane, id, boundGeneration, boundSettle));
			}
		})();

		this.track(step.catch(() => undefined));
	}

	private routeComplete(id: string, frame: string): void {
		const lane = this.lanes.get(id);

		if (lane === undefined) {
			this.track(this.deliver(frame));
			return;
		}

		const priorTail = lane.tail;
		if (lane.current !== null && !lane.current.settledFlag) lane.current.completed = true;

		lane.pending++;

		let markStarted!: () => void;

		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});

		lane.tail = started;

		const step = (async () => {
			await Promise.race([priorTail, this.stopSignal]);

			if (this.stopped) {
				this.settleStart(lane, id, markStarted);
				return;
			}

			this.track(this.deliver(frame));
			this.settleStart(lane, id, markStarted);
		})();

		this.track(step.catch(() => undefined));
	}

	private settleStart(lane: OperationLane, id: string, markStarted: () => void): void {
		lane.pending--;
		markStarted();
		this.reap(lane, id);
	}

	private settleGeneration(lane: OperationLane, id: string, generation: Generation, markSettled: () => void): void {
		generation.settledFlag = true;
		markSettled();
		if (lane.current === generation) lane.current = null;
		this.reap(lane, id);
	}

	private reap(lane: OperationLane, id: string): void {
		if (lane.pending === 0 && lane.current === null && this.lanes.get(id) === lane) {
			this.lanes.delete(id);
		}
	}
}
